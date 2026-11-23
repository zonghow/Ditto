import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { readJson, writePrivateJson, removeFile, SerialQueue } from './files.js';
import { InputError, snapshotSummary } from './snapshot.js';

export class SyncStore extends EventEmitter {
  queue = new SerialQueue();
  pending = null;
  applied = null;
  hasEnvelope = false;

  constructor(dataDir) {
    super();
    this.pendingFile = path.join(dataDir, 'pending.json');
    this.appliedFile = path.join(dataDir, 'applied.json');
    this.envelopeFile = path.join(dataDir, 'cookiecloud.json');
  }

  async load() {
    this.pending = await readJson(this.pendingFile);
    this.applied = await readJson(this.appliedFile);
    this.hasEnvelope = Boolean(await readJson(this.envelopeFile));
  }

  summary() {
    return {
      pending: this.pending ? {
        id: this.pending.id, receivedAt: this.pending.receivedAt,
        ...snapshotSummary(this.pending.snapshot),
      } : null,
      applied: this.applied,
    };
  }

  receive(snapshot, envelope = null) {
    return this.queue.run(async () => {
      const pending = { id: randomUUID(), receivedAt: new Date().toISOString(), snapshot };
      await writePrivateJson(this.pendingFile, pending);
      if (envelope) {
        await writePrivateJson(this.envelopeFile, envelope);
        this.hasEnvelope = true;
      } else if (this.hasEnvelope) {
        await removeFile(this.envelopeFile);
        this.hasEnvelope = false;
      }
      this.pending = pending;
      this.emit('change', this.summary());
      return this.summary().pending;
    });
  }

  discard() {
    return this.queue.run(async () => {
      await removeFile(this.pendingFile);
      this.pending = null;
      this.emit('change', this.summary());
    });
  }

  apply(id, browser) {
    return this.queue.run(async () => {
      if (!this.pending || (id !== undefined && id !== this.pending.id)) throw new InputError('待应用的同步数据已变化，请刷新后重试。', 409);
      if (!browser.ready) throw new InputError('Chromium 尚未就绪。', 503);
      const result = await browser.importSnapshot(this.pending.snapshot);
      this.applied = {
        ...snapshotSummary(this.pending.snapshot), id: this.pending.id,
        appliedAt: new Date().toISOString(), ...result,
      };
      // Retain metadata only once plaintext login state has reached the private profile.
      await writePrivateJson(this.appliedFile, this.applied);
      await removeFile(this.pendingFile);
      this.pending = null;
      this.emit('change', this.summary());
      return this.applied;
    });
  }

  // Fast-path for live syncs when Chromium is already ready: applies directly
  // without a transient pending.json write+unlink cycle, while preserving
  // durability by staging pending.json if Chromium is not ready or import fails.
  applyDirect(snapshot, browser, envelope = null) {
    return this.queue.run(async () => {
      const id = randomUUID();
      const receivedAt = new Date().toISOString();
      const pendingSummary = { id, receivedAt, ...snapshotSummary(snapshot) };
      if (envelope || !browser?.ready) {
        const pending = { id, receivedAt, snapshot };
        await writePrivateJson(this.pendingFile, pending);
        if (envelope) {
          await writePrivateJson(this.envelopeFile, envelope);
          this.hasEnvelope = true;
        } else if (this.hasEnvelope) {
          await removeFile(this.envelopeFile);
          this.hasEnvelope = false;
        }
        this.pending = pending;
        this.emit('change', this.summary());
        return { pending: pendingSummary, applied: null };
      }
      try {
        const result = await browser.importSnapshot(snapshot);
        this.applied = {
          ...snapshotSummary(snapshot), id,
          appliedAt: new Date().toISOString(), ...result,
        };
        await writePrivateJson(this.appliedFile, this.applied);
        if (this.pending) {
          await removeFile(this.pendingFile);
          this.pending = null;
        }
        if (this.hasEnvelope) {
          await removeFile(this.envelopeFile);
          this.hasEnvelope = false;
        }
        this.emit('change', this.summary());
        return { pending: pendingSummary, applied: this.applied };
      } catch (error) {
        const pending = { id, receivedAt, snapshot };
        await writePrivateJson(this.pendingFile, pending);
        if (this.hasEnvelope) {
          await removeFile(this.envelopeFile);
          this.hasEnvelope = false;
        }
        this.pending = pending;
        this.emit('change', this.summary());
        throw error;
      }
    });
  }

  async envelope() {
    return readJson(this.envelopeFile);
  }
}
