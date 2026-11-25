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
    this.coordWidth = null;
    this.coordHeight = null;
    this.dragging = false;
    this.lastInputAt = 0;
    this.lastMove = 0;
    this.pendingMove = null;
    this.moveTimer = null;
    this.lastWheelSent = 0;
    this.pendingWheel = null;
    this.wheelTimer = null;
    this.decoding = false;
    this.queuedBinary = null;
    this.frameToken = 0;
    this.lastObjectUrl = null;
    this.pendingImageMeta = null;
    this.frameImage = new Image();
    this.frameImage.onload = () => {
      const prevUrl = this.lastObjectUrl;
      this.lastObjectUrl = null;
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      if (!this.active) return;
      this.drawSource(this.frameImage, this.frameImage.naturalWidth, this.frameImage.naturalHeight, this.pendingImageMeta);
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

  drawSource(source, width, height, meta = null) {
    if (!width || !height) return;
    const deviceW = Number(meta?.width) > 0 ? Number(meta.width) : (this.width || width);
    const deviceH = Number(meta?.height) > 0 ? Number(meta.height) : (this.height || height);
    const offsetTop = Number.isFinite(meta?.offsetTop) && meta.offsetTop > 0 && meta.offsetTop < deviceH
      ? Number(meta.offsetTop) : 0;
    const scaleFactor = Number.isFinite(meta?.pageScaleFactor) && meta.pageScaleFactor > 0
      ? Number(meta.pageScaleFactor) : 1;
    const capturedCssW = deviceW / scaleFactor;
    const capturedCssH = Math.max(1, (deviceH - offsetTop) / scaleFactor);
    const vpW = Number(meta?.viewportWidth) > 0 ? Number(meta.viewportWidth) : capturedCssW;
    const vpH = Number(meta?.viewportHeight) > 0 ? Number(meta.viewportHeight) : capturedCssH;

    // Crop dead padding when Chromium's compositor window exceeds the emulated viewport.
    const srcY = offsetTop > 0 ? Math.min(height - 1, Math.round(height * (offsetTop / deviceH))) : 0;
    const availH = Math.max(1, height - srcY);
    const cropRatioX = Math.min(1, vpW / capturedCssW);
    const cropRatioY = Math.min(1, vpH / capturedCssH);
    const srcW = Math.max(1, Math.min(width, Math.round(width * cropRatioX)));
    const srcH = Math.max(1, Math.min(availH, Math.round(availH * cropRatioY)));

    // Record exact CSS coordinate span represented by the drawn canvas so input
    // mapping stays 1:1 even when frames are scaled, cropped, or resized in flight.
    const nextCoordW = capturedCssW * (srcW / width);
    const nextCoordH = capturedCssH * (srcH / availH);
    const coordChanged = this.coordWidth !== nextCoordW || this.coordHeight !== nextCoordH;
    this.coordWidth = nextCoordW;
    this.coordHeight = nextCoordH;

    const resized = this.canvas.width !== srcW || this.canvas.height !== srcH;
    if (resized) {
      this.canvas.width = srcW;
      this.canvas.height = srcH;
    }
    this.ctx.drawImage(source, 0, srcY, srcW, srcH, 0, 0, srcW, srcH);
    if (resized || coordChanged || !this.canvas.style.width) this.fit();
  }

  coords(event) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    if (Number.isFinite(this.coordWidth) && this.coordWidth > 0 &&
      Number.isFinite(this.coordHeight) && this.coordHeight > 0) {
      return { x, y, frameWidth: this.coordWidth, frameHeight: this.coordHeight };
    }
    return { x, y };
  }

  clearPendingMove() {
    clearTimeout(this.moveTimer);
    this.moveTimer = null;
    this.pendingMove = null;
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
      this.clearPendingMove();
      this.dragging = true;
      this.lastInputAt = Date.now();
      try { this.canvas.setPointerCapture(event.pointerId); } catch {}
      this.send({ type: 'screencast-input', tabId: this.tabId, action: 'mousedown', ...pt, button: this.buttonName(event.button) });
    });
    this.canvas.addEventListener('pointermove', event => {
      if (!this.active || !this.tabId) return;
      const pt = this.coords(event);
      if (!pt) return;
      const now = Date.now();
      const minGap = this.dragging ? 16 : 32;
      if (!this.moveTimer && now - this.lastMove >= minGap) {
        this.lastMove = now;
        this.pendingMove = null;
        this.send({ type: 'screencast-input', tabId: this.tabId, action: 'mousemove', ...pt });
        return;
      }
      // Trailing flush guarantees final hover/drag position always reaches Chromium.
      this.pendingMove = pt;
      if (!this.moveTimer) {
        const wait = Math.max(4, minGap - (now - this.lastMove));
        this.moveTimer = setTimeout(() => {
          this.moveTimer = null;
          const item = this.pendingMove;
          this.pendingMove = null;
          if (item && this.active && this.tabId) {
            this.lastMove = Date.now();
            this.send({ type: 'screencast-input', tabId: this.tabId, action: 'mousemove', ...item });
          }
        }, wait);
      }
    });
    const endDrag = event => {
      if (!this.active || !this.tabId || !this.dragging) return;
      this.dragging = false;
      this.clearPendingMove();
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
        this.pendingWheel.frameWidth = pt.frameWidth;
        this.pendingWheel.frameHeight = pt.frameHeight;
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
      this.coordWidth = null;
      this.coordHeight = null;
      this.clearPendingMove();
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
    this.coordWidth = null;
    this.coordHeight = null;
    this.frameToken++;
    this.queuedBinary = null;
    this.pendingImageMeta = null;
    if (this.lastObjectUrl) {
      URL.revokeObjectURL(this.lastObjectUrl);
      this.lastObjectUrl = null;
    }
    this.clearPendingMove();
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
      this.pendingImageMeta = meta;
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
          this.drawSource(bitmap, bitmap.width, bitmap.height, meta);
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
    this.pendingImageMeta = frame;
    this.frameImage.src = `data:image/jpeg;base64,${frame.data}`;
  }

  fit() {
    if (!this.active || !this.bounds) return;
    const availW = this.bounds.clientWidth;
    const availH = this.bounds.clientHeight;
    if (!availW || !availH) return;
    const aspectW = this.coordWidth || this.canvas.width || this.width || 1920;
    const aspectH = this.coordHeight || this.canvas.height || this.height || 1080;
    const scale = Math.min(availW / aspectW, availH / aspectH);
    this.canvas.style.width = `${Math.floor(aspectW * scale)}px`;
    this.canvas.style.height = `${Math.floor(aspectH * scale)}px`;
  }
}
