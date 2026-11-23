const SPECIAL_KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

export class RemoteControl {
  constructor({ surface, editor, select, send, notify, blocked = () => {} }) {
    this.surface = surface;
    this.editor = editor;
    editor.maxLength = 16384;
    this.select = select;
    this.send = send;
    this.notify = notify;
    this.blocked = blocked;
    this.enabled = false;
    this.target = null;
    this.lastMove = 0;
    this.lastHover = 0;
    this.lastWheelSent = 0;
    this.pendingWheel = null;
    this.wheelTimer = null;
    this.wheelRemX = 0;
    this.wheelRemY = 0;
    this.wheelRemAt = 0;
    const clearPress = () => this.replay?.press?.(null);
    window.addEventListener('pointerup', clearPress);
    window.addEventListener('pointercancel', clearPress);
    window.addEventListener('blur', clearPress);
    surface.addEventListener('pointerdown', event => {
      if (!this.enabled || event.button !== 0) return;
      const target = this.replay?.hit(event.clientX, event.clientY);
      this.replay?.press?.(target?.node || null);
    });
    surface.addEventListener('click', event => {
      this.replay?.press?.(null);
      if (!this.enabled) { event.preventDefault(); this.blocked(); return; }
      this.pointer(event);
    });
    surface.addEventListener('contextmenu', event => { event.preventDefault(); this.pointer(event, 'right'); });
    surface.addEventListener('pointermove', event => {
      const now = Date.now();
      if (now - this.lastHover < 28) return;
      this.lastHover = now;
      const target = this.replay?.hit(event.clientX, event.clientY);
      this.replay?.hover(target?.node || null);
      if (!this.enabled) {
        this.surface.style.cursor = '';
        return;
      }
      this.surface.style.cursor = target ? (this.replay?.cursorFor(target.node) || '') : '';
      // Forward remote hover at ~40ms so JS tooltips and hover menus stay responsive
      // without flooding the control queue behind a slow page.
      if (now - this.lastMove < 40) return;
      this.lastMove = now;
      if (target) this.command('move', target);
    });
    surface.addEventListener('pointerleave', () => {
      this.replay?.hover(null);
      this.replay?.press?.(null);
      this.surface.style.cursor = '';
    });
    surface.addEventListener('wheel', event => {
      if (!this.enabled) return;
      event.preventDefault();
      const target = this.replay?.hit(event.clientX, event.clientY);
      if (!target) return;
      const modeScale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
      const now = performance.now();
      if (now - this.wheelRemAt > 250) {
        this.wheelRemX = 0;
        this.wheelRemY = 0;
      }
      this.wheelRemAt = now;
      const rawX = event.deltaX * modeScale + this.wheelRemX;
      const rawY = event.deltaY * modeScale + this.wheelRemY;
      const dx = Math.max(-4000, Math.min(4000, Math.trunc(rawX)));
      const dy = Math.max(-4000, Math.min(4000, Math.trunc(rawY)));
      this.wheelRemX = rawX - dx;
      this.wheelRemY = rawY - dy;
      if (!dx && !dy) return;
      // 0ms optimistic local scroll on the replay DOM; remote scroll reconciles once gesture settles.
      this.replay?.optimisticScroll?.(target.node, dx, dy);
      this.hideEditor();
      if (!this.wheelTimer && !this.pendingWheel && now - this.lastWheelSent >= 16) {
        this.lastWheelSent = now;
        this.command('wheel', target, { deltaX: dx, deltaY: dy });
        return;
      }
      if (this.pendingWheel) {
        this.pendingWheel.target = target;
        this.pendingWheel.deltaX = Math.max(-4000, Math.min(4000, this.pendingWheel.deltaX + dx));
        this.pendingWheel.deltaY = Math.max(-4000, Math.min(4000, this.pendingWheel.deltaY + dy));
      } else {
        this.pendingWheel = { target, deltaX: dx, deltaY: dy };
      }
      if (!this.wheelTimer) {
        const wait = Math.max(4, Math.round(16 - (now - this.lastWheelSent)));
        this.wheelTimer = setTimeout(() => this.flushWheel(), wait);
      }
    }, { passive: false });
    surface.addEventListener('keydown', event => this.key(event));
    surface.addEventListener('paste', event => {
      if (!this.enabled || !this.target) return;
      event.preventDefault();
      this.command('text', this.target, { value: event.clipboardData.getData('text/plain').slice(0, 16384) });
    });
    editor.addEventListener('input', () => {
      if (!this.enabled || !this.target || this.composing) return;
      this.sendEditor();
    });
    editor.addEventListener('compositionstart', () => { this.composing = true; });
    editor.addEventListener('compositionend', () => { this.composing = false; this.sendEditor(); });
    editor.addEventListener('keydown', event => this.key(event, true));
    select.addEventListener('change', () => {
      if (this.enabled && this.target) {
        this.replay?.optimisticSelect?.(this.target.nodeId, select.value);
        this.command('select', this.target, { value: select.value });
        this.hideEditor();
      }
    });
  }

  bind(replay) {
    if (this.replay === replay) return;
    this.replay?.press?.(null);
    clearTimeout(this.wheelTimer);
    this.wheelTimer = null;
    this.pendingWheel = null;
    this.wheelRemX = 0;
    this.wheelRemY = 0;
    this.replay = replay;
    this.target = null;
    this.hideEditor();
  }

  setAvailable(available) {
    this.available = available;
    this.surface.hidden = !available;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.surface.hidden = !this.available;
    this.surface.dataset.mode = enabled ? 'control' : 'readonly';
    this.surface.setAttribute('aria-hidden', String(!this.available));
    if (!enabled) { this.replay?.press?.(null); this.target = null; this.surface.style.cursor = ''; this.hideEditor(); }
  }

  flushWheel() {
    clearTimeout(this.wheelTimer);
    this.wheelTimer = null;
    const item = this.pendingWheel;
    this.pendingWheel = null;
    if (!item || !this.enabled) return;
    this.lastWheelSent = performance.now();
    this.command('wheel', item.target, { deltaX: item.deltaX, deltaY: item.deltaY });
  }

  command(action, target, extra = {}) {
    if (!this.enabled || !this.replay || !target) return;
    const { nodeId, framePath, offsetX, offsetY, viewportX, viewportY } = target;
    const payload = {
      type: 'control',
      action,
      nodeId,
      framePath,
      offsetX,
      offsetY,
      documentId: this.replay.documentId,
      ...extra,
    };
    if (action === 'wheel' && Number.isFinite(viewportX) && Number.isFinite(viewportY)) {
      payload.viewportX = viewportX;
      payload.viewportY = viewportY;
    }
    this.send(payload);
  }

  pointer(event, button = 'left') {
    if (!this.enabled || !this.replay) return;
    event.preventDefault();
    const target = this.replay.hit(event.clientX, event.clientY);
    if (!target) { this.notify('这部分没有可操作的 rrweb 节点（例如跨域 iframe）。'); return; }
    if (target.nodeId !== this.target?.nodeId) this.hideEditor();
    this.target = target;
    if (button === 'left') this.replay.optimisticToggle?.(target.node);
    this.command('click', target, { button, clickCount: Math.min(2, event.detail || 1) });
    this.surface.focus({ preventScroll: true });
    // The remote focus event selects the final field after React/label handlers.
    // Optimistically open the IME-capable local editor for ordinary fields.
    this.focus(target.nodeId);
  }

  focus(id) {
    if (!this.enabled || !this.replay) return;
    const node = this.replay.node(id);
    const target = this.replay.target(node);
    if (!node || !target) return;
    if (this.target?.nodeId === id && !this.editor.hidden && this.editor === document.activeElement) return;
    this.target = target;
    const editable = node.tagName === 'SELECT' || node.isContentEditable || (['INPUT', 'TEXTAREA'].includes(node.tagName) &&
      !['hidden', 'file', 'radio', 'checkbox', 'submit', 'button', 'range', 'color'].includes(node.type));
    if (!editable || node.disabled || node.readOnly) { this.hideEditor(); return; }
    // Passwords are masked by the recorder. Never place the masked remote value
    // back into a real field; use insertText/key events rather than fill.
    this.password = node.type === 'password';
    this.contentEditable = node.isContentEditable;
    const control = node.tagName === 'SELECT' ? this.select : this.editor;
    this.editor.hidden = control !== this.editor;
    this.select.hidden = control !== this.select;
    if (control === this.select) {
      this.select.replaceChildren(...[...node.options].map(option => {
        const copy = document.createElement('option');
        copy.textContent = option.textContent;
        copy.value = option.value;
        copy.disabled = option.disabled;
        return copy;
      }));
      this.select.value = node.value;
    } else this.editor.value = this.password ? '' : (this.contentEditable ? node.textContent : node.value || '');
    this.editor.setAttribute('aria-label', this.password ? '远端密码输入（不回传密码画面）' : '远端网页输入');
    this.editor.dataset.password = String(this.password);
    this.editor.style.webkitTextSecurity = this.password ? 'disc' : 'none';
    const rect = node.getBoundingClientRect();
    const frameRect = this.replay.player.iframe.getBoundingClientRect();
    const surfaceRect = this.surface.getBoundingClientRect();
    const scale = frameRect.width / this.replay.width;
    let left = rect.left;
    let top = rect.top;
    let win = node.ownerDocument.defaultView;
    try {
      while (win !== this.replay.player.iframe.contentWindow) {
        const frame = win.frameElement;
        const box = frame.getBoundingClientRect();
        left += box.left + frame.clientLeft;
        top += box.top + frame.clientTop;
        win = frame.ownerDocument.defaultView;
      }
    } catch { this.hideEditor(); return; }
    control.style.left = `${Math.max(0, frameRect.left - surfaceRect.left + left * scale)}px`;
    control.style.top = `${Math.max(0, frameRect.top - surfaceRect.top + top * scale)}px`;
    control.style.width = `${Math.min(surfaceRect.width, Math.max(45, rect.width * scale))}px`;
    control.style.height = `${Math.max(25, rect.height * scale)}px`;
    control.hidden = false;
    control.focus({ preventScroll: true });
    if (control === this.editor) this.editor.setSelectionRange(this.editor.value.length, this.editor.value.length);
    this.previousValue = this.editor.value;
  }

  sendEditor() {
    if (this.password) {
      const old = this.previousValue || '';
      const value = this.editor.value;
      if (value.startsWith(old)) this.command('text', this.target, { value: value.slice(old.length), appendToPassword: true });
      else this.notify('密码字段支持追加输入和退格；要替换整段请先在远端字段全选。');
      this.previousValue = value;
      return;
    }
    this.command('input', this.target, { value: this.editor.value.slice(0, 16384),
      selectionStart: this.editor.selectionStart, selectionEnd: this.editor.selectionEnd });
  }

  key(event, inEditor = false) {
    if (!this.enabled || !this.target || event.isComposing) return;
    const modified = event.ctrlKey || event.metaKey || event.altKey;
    if (inEditor && !this.password && (event.ctrlKey || event.metaKey) && /^[acvxyz]$/i.test(event.key)) return;
    const special = SPECIAL_KEYS.has(event.key) || (inEditor && this.password && event.key === 'Backspace');
    if (inEditor && !modified && !special) return;
    if (!special && !modified && event.key.length !== 1) return;
    if (inEditor && !this.password && ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) && !modified) return;
    event.preventDefault();
    if (!modified && event.key.length === 1) this.command('text', this.target, { value: event.key });
    else {
      const modifiers = [];
      if (event.ctrlKey) modifiers.push('Control');
      if (event.metaKey) modifiers.push('Meta');
      if (event.altKey) modifiers.push('Alt');
      if (event.shiftKey) modifiers.push('Shift');
      this.command('key', this.target, { key: event.key === ' ' ? 'Space' : event.key, modifiers });
    }
    if (this.password && ['Backspace', 'Delete'].includes(event.key)) {
      this.editor.value = this.editor.value.slice(0, -1);
      this.previousValue = this.editor.value;
    }
    if (event.key === 'Escape' || event.key === 'Tab' || event.key === 'Enter') this.hideEditor();
  }

  isEditing() {
    return Boolean((!this.editor.hidden && document.activeElement === this.editor)
      || (!this.select.hidden && document.activeElement === this.select));
  }

  hideEditor() {
    this.editor.hidden = true;
    this.select.hidden = true;
    this.select.replaceChildren();
    this.editor.value = '';
    this.previousValue = '';
    this.composing = false;
  }
}
