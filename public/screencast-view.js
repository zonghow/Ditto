const SPECIAL_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown',
]);

export class ScreencastView {
  constructor({ container, canvas, send }) {
    this.container = container;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.send = send;
    this.active = false;
    this.tabId = null;
    this.width = 1920;
    this.height = 1080;
    this.dragging = false;
    this.lastInputAt = 0;
    this.lastMove = 0;
    this.lastWheelSent = 0;
    this.pendingWheel = null;
    this.wheelTimer = null;
    this.decoding = false;
    this.queuedBinary = null;
    this.frameToken = 0;
    this.lastObjectUrl = null;
    this.frameImage = new Image();
    this.frameImage.onload = () => {
      const prevUrl = this.lastObjectUrl;
      this.lastObjectUrl = null;
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      if (!this.active) return;
      this.drawSource(this.frameImage, this.frameImage.naturalWidth, this.frameImage.naturalHeight);
    };
    this.frameImage.onerror = () => {
      const prevUrl = this.lastObjectUrl;
      this.lastObjectUrl = null;
      if (prevUrl) URL.revokeObjectURL(prevUrl);
    };
    this.bounds = container.closest('.stage') || container;
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.bounds);
    this.bindEvents();
  }

  drawSource(source, width, height) {
    if (!width || !height) return;
    const resized = this.canvas.width !== width || this.canvas.height !== height;
    if (resized) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ctx.drawImage(source, 0, 0);
    if (resized || !this.canvas.style.width) this.fit();
  }

  coords(event) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    return { x, y };
  }

  buttonName(button) {
    if (button === 1) return 'middle';
    if (button === 2) return 'right';
    return 'left';
  }

  bindEvents() {
    this.canvas.addEventListener('pointerdown', event => {
      if (!this.active || !this.tabId) return;
      event.preventDefault();
      this.canvas.focus({ preventScroll: true });
      const pt = this.coords(event);
      if (!pt) return;
      this.dragging = true;
      this.lastInputAt = Date.now();
      try { this.canvas.setPointerCapture(event.pointerId); } catch {}
      this.send({ type: 'screencast-input', tabId: this.tabId, action: 'mousedown', ...pt, button: this.buttonName(event.button) });
    });
    this.canvas.addEventListener('pointermove', event => {
      if (!this.active || !this.tabId) return;
      const now = Date.now();
      const minGap = this.dragging ? 20 : 40;
      if (now - this.lastMove < minGap) return;
      this.lastMove = now;
      const pt = this.coords(event);
      if (pt) this.send({ type: 'screencast-input', tabId: this.tabId, action: 'mousemove', ...pt });
    });
    const endDrag = event => {
      if (!this.active || !this.tabId || !this.dragging) return;
      this.dragging = false;
      try { this.canvas.releasePointerCapture(event.pointerId); } catch {}
      const pt = this.coords(event);
      if (pt) this.send({ type: 'screencast-input', tabId: this.tabId, action: 'mouseup', ...pt, button: this.buttonName(event.button) });
    };
    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);
    this.canvas.addEventListener('contextmenu', event => { if (this.active) event.preventDefault(); });
    this.canvas.addEventListener('wheel', event => {
      if (!this.active || !this.tabId) return;
      event.preventDefault();
      const pt = this.coords(event);
      if (!pt) return;
      const modeScale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
      const dx = Math.max(-4000, Math.min(4000, event.deltaX * modeScale));
      const dy = Math.max(-4000, Math.min(4000, event.deltaY * modeScale));
      if (!dx && !dy) return;
      const now = performance.now();
      if (!this.wheelTimer && !this.pendingWheel && now - this.lastWheelSent >= 16) {
        this.lastWheelSent = now;
        this.send({ type: 'screencast-input', tabId: this.tabId, action: 'wheel', ...pt, deltaX: dx, deltaY: dy });
        return;
      }
      if (this.pendingWheel) {
        this.pendingWheel.x = pt.x;
        this.pendingWheel.y = pt.y;
        this.pendingWheel.deltaX = Math.max(-4000, Math.min(4000, this.pendingWheel.deltaX + dx));
        this.pendingWheel.deltaY = Math.max(-4000, Math.min(4000, this.pendingWheel.deltaY + dy));
      } else {
        this.pendingWheel = { ...pt, deltaX: dx, deltaY: dy };
      }
      if (!this.wheelTimer) {
        const wait = Math.max(4, Math.round(16 - (now - this.lastWheelSent)));
        this.wheelTimer = setTimeout(() => {
          this.wheelTimer = null;
          const item = this.pendingWheel;
          this.pendingWheel = null;
          if (item && this.active && this.tabId) {
            this.lastWheelSent = performance.now();
            this.send({ type: 'screencast-input', tabId: this.tabId, action: 'wheel', ...item });
          }
        }, wait);
      }
    }, { passive: false });
    this.canvas.addEventListener('keydown', event => {
      if (!this.active || !this.tabId || event.isComposing) return;
      const modified = event.ctrlKey || event.metaKey || event.altKey;
      const special = SPECIAL_KEYS.has(event.key);
      if (!special && !modified && event.key.length !== 1) return;
      event.preventDefault();
      this.lastInputAt = Date.now();
      if (!modified && event.key.length === 1) {
        this.send({ type: 'screencast-input', tabId: this.tabId, action: 'text', value: event.key });
      } else {
        const modifiers = [];
        if (event.ctrlKey) modifiers.push('Control');
        if (event.metaKey) modifiers.push('Meta');
        if (event.altKey) modifiers.push('Alt');
        if (event.shiftKey) modifiers.push('Shift');
        this.send({ type: 'screencast-input', tabId: this.tabId, action: 'key', key: event.key === ' ' ? 'Space' : event.key, modifiers });
      }
    });
    this.canvas.addEventListener('paste', event => {
      if (!this.active || !this.tabId) return;
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain')?.slice(0, 16384);
      if (text) this.send({ type: 'screencast-input', tabId: this.tabId, action: 'text', value: text });
    });
  }

  show(tabId) {
    const switching = this.tabId !== tabId;
    this.active = true;
    this.tabId = tabId;
    this.frameToken++;
    this.queuedBinary = null;
    if (switching) {
      this.dragging = false;
      clearTimeout(this.wheelTimer);
      this.wheelTimer = null;
      this.pendingWheel = null;
      if (this.canvas.width && this.canvas.height) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
    }
    this.container.hidden = false;
    this.fit();
  }

  hide() {
    this.active = false;
    this.tabId = null;
    this.dragging = false;
    this.frameToken++;
    this.queuedBinary = null;
    if (this.lastObjectUrl) {
      URL.revokeObjectURL(this.lastObjectUrl);
      this.lastObjectUrl = null;
    }
    clearTimeout(this.wheelTimer);
    this.wheelTimer = null;
    this.pendingWheel = null;
    this.container.hidden = true;
  }

  renderBinaryFrame(meta, jpegBytes) {
    if (!this.active || meta.tabId !== this.tabId || !jpegBytes?.byteLength) return;
    if (meta.width && meta.height) {
      this.width = meta.width;
      this.height = meta.height;
    }
    if (typeof createImageBitmap !== 'function') {
      const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      if (this.lastObjectUrl) URL.revokeObjectURL(this.lastObjectUrl);
      this.lastObjectUrl = url;
      this.frameImage.src = url;
      return;
    }
    if (this.decoding) {
      // Always keep only the latest un-decoded frame so rendering never lags behind.
      this.queuedBinary = { meta, jpegBytes };
      return;
    }
    this.decodeBinary(meta, jpegBytes);
  }

  decodeBinary(meta, jpegBytes) {
    this.decoding = true;
    const token = this.frameToken;
    const targetTabId = meta.tabId;
    const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
    createImageBitmap(blob).then(bitmap => {
      try {
        if (this.active && this.frameToken === token && this.tabId === targetTabId) {
          this.drawSource(bitmap, bitmap.width, bitmap.height);
        }
      } finally {
        bitmap.close?.();
      }
    }).catch(() => {}).finally(() => {
      this.decoding = false;
      const next = this.queuedBinary;
      this.queuedBinary = null;
      if (next && this.active && this.frameToken === token && next.meta.tabId === this.tabId) {
        this.decodeBinary(next.meta, next.jpegBytes);
      }
    });
  }

  renderFrame(frame) {
    if (!this.active || frame.tabId !== this.tabId || typeof frame.data !== 'string') return;
    if (frame.width && frame.height) {
      this.width = frame.width;
      this.height = frame.height;
    }
    this.frameImage.src = `data:image/jpeg;base64,${frame.data}`;
  }

  fit() {
    if (!this.active || !this.bounds) return;
    const availW = this.bounds.clientWidth;
    const availH = this.bounds.clientHeight;
    if (!availW || !availH) return;
    const aspectW = this.canvas.width || this.width || 1920;
    const aspectH = this.canvas.height || this.height || 1080;
    const scale = Math.min(availW / aspectW, availH / aspectH);
    this.canvas.style.width = `${Math.floor(aspectW * scale)}px`;
    this.canvas.style.height = `${Math.floor(aspectH * scale)}px`;
  }
}
