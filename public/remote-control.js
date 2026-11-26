const SPECIAL_KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

export class RemoteControl {
  constructor({ surface, editor, select, send, notify, blocked = () => {}, onCopy = null }) {
    this.surface = surface;
    this.editor = editor;
    editor.maxLength = 16384;
    this.select = select;
    this.send = send;
    this.notify = notify;
    this.blocked = blocked;
    this.onCopy = onCopy;
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
    this.drag = null;
    this.dragMoveTimer = null;
    this.pendingDragMove = null;
    this.lastDragMove = 0;
    this.suppressClickUntil = 0;
    this.lastDownAt = 0;
    this.lastDownX = 0;
    this.lastDownY = 0;
    this.lastDownButton = -1;
    this.lastDownCount = 0;
    window.addEventListener('pointerup', event => this.finishDrag(event, false));
    window.addEventListener('pointercancel', event => this.finishDrag(event, true));
    window.addEventListener('blur', () => this.finishDrag(null, true));
    surface.addEventListener('pointerdown', event => {
      if (!this.enabled || event.button !== 0) return;
      const target = this.replay?.hit(event.clientX, event.clientY);
      this.replay?.press?.(target?.node || null);
      const now = performance.now();
      const sameSpot = event.button === this.lastDownButton
        && now - this.lastDownAt <= 500
        && Math.hypot(event.clientX - this.lastDownX, event.clientY - this.lastDownY) <= 8;
      const clickCount = sameSpot ? Math.min(3, this.lastDownCount + 1) : 1;
      this.lastDownAt = now;
      this.lastDownX = event.clientX;
      this.lastDownY = event.clientY;
      this.lastDownButton = event.button;
      this.lastDownCount = clickCount;
      this.drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startTarget: target,
        lastTarget: target,
        dragged: false,
        clickCount,
      };
    });
    surface.addEventListener('mousedown', event => {
      if (!this.enabled || event.button !== 0 || !this.drag || this.drag.dragged) return;
      if (event.detail >= 1) this.drag.clickCount = Math.min(3, event.detail);
    });
    surface.addEventListener('click', event => {
      this.replay?.press?.(null);
      if (performance.now() < this.suppressClickUntil) {
        this.suppressClickUntil = 0;
        event.preventDefault();
        return;
      }
      if (!this.enabled) { event.preventDefault(); this.blocked(); return; }
      this.pointer(event);
    });
    surface.addEventListener('contextmenu', event => { event.preventDefault(); this.pointer(event, 'right'); });
    surface.addEventListener('pointermove', event => {
      if (this.drag && this.enabled && event.pointerId === this.drag.pointerId) {
        if (!this.drag.dragged) {
          if (Math.hypot(event.clientX - this.drag.startX, event.clientY - this.drag.startY) < 5) return;
          if (!this.drag.startTarget) return;
          this.drag.dragged = true;
          this.replay?.press?.(null);
          try { this.surface.setPointerCapture(this.drag.pointerId); } catch {}
          if (this.drag.startTarget.nodeId !== this.target?.nodeId) this.hideEditor();
          this.target = this.drag.startTarget;
          this.command('mousedown', this.drag.startTarget, { button: 'left', clickCount: this.drag.clickCount });
        }
        const moveTarget = this.resolveDragTarget(event.clientX, event.clientY, this.drag.lastTarget);
        if (moveTarget) {
          this.drag.lastTarget = moveTarget;
          this.queueDragMove(moveTarget);
        }
        return;
      }
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
    editor.addEventListener('compositionstart', () => {
      this.composing = true;
      editor.classList.add('is-composing');
    });
    editor.addEventListener('compositionend', () => {
      this.composing = false;
      editor.classList.remove('is-composing');
      this.sendEditor();
    });
    editor.addEventListener('paste', event => {
      if (!this.enabled || !this.target || !this.incremental) return;
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain') || '';
      if (!text) return;
      this.command('text', this.target, { value: text.slice(0, 16384), ...(this.password ? { appendToPassword: true } : {}) });
    });
    editor.addEventListener('keydown', event => this.key(event, true));
    select.addEventListener('change', () => {
      if (this.enabled && this.target) {
        this.replay?.optimisticSelect?.(this.target.nodeId, select.value);
        this.command('select', this.target, { value: select.value });
        this.hideEditor();
      }
    });
  }

  clearDragMove() {
    clearTimeout(this.dragMoveTimer);
    this.dragMoveTimer = null;
    this.pendingDragMove = null;
  }

  resolveDragTarget(clientX, clientY, fallback) {
    const hit = this.replay?.hit(clientX, clientY, { clamp: true });
    if (hit) return hit;
    const vp = this.replay?.viewportPoint?.(clientX, clientY);
    if (vp && fallback) return { ...fallback, ...vp };
    return fallback || null;
  }

  queueDragMove(target) {
    const now = performance.now();
    if (!this.dragMoveTimer && now - this.lastDragMove >= 24) {
      this.lastDragMove = now;
      this.pendingDragMove = null;
      this.command('move', target, { dragging: true });
      return;
    }
    this.pendingDragMove = target;
    if (!this.dragMoveTimer) {
      const wait = Math.max(4, Math.round(24 - (now - this.lastDragMove)));
      this.dragMoveTimer = setTimeout(() => {
        this.dragMoveTimer = null;
        const item = this.pendingDragMove;
        this.pendingDragMove = null;
        if (item && this.drag?.dragged && this.enabled) {
          this.lastDragMove = performance.now();
          this.command('move', item, { dragging: true });
        }
      }, wait);
    }
  }

  finishDrag(event = null, canceled = false) {
    this.replay?.press?.(null);
    if (!this.drag) return;
    if (event?.pointerId !== undefined && this.drag.pointerId !== event.pointerId) return;
    const drag = this.drag;
    this.drag = null;
    this.clearDragMove();
    if (!drag.dragged) return;
    try { this.surface.releasePointerCapture(drag.pointerId); } catch {}
    const endTarget = (!canceled && event)
      ? this.resolveDragTarget(event.clientX, event.clientY, drag.lastTarget)
      : drag.lastTarget;
    if (endTarget && this.enabled) {
      this.command('mouseup', endTarget, { button: 'left', clickCount: drag.clickCount });
    }
    this.suppressClickUntil = performance.now() + 300;
    if (this.editor.hidden && this.select.hidden) this.surface.focus({ preventScroll: true });
  }

  bind(replay) {
    if (this.replay === replay) return;
    this.replay?.press?.(null);
    this.drag = null;
    this.clearDragMove();
    this.suppressClickUntil = 0;
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
    if (!enabled) {
      this.replay?.press?.(null);
      this.drag = null;
      this.clearDragMove();
      this.target = null;
      this.surface.style.cursor = '';
      this.hideEditor();
    }
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
    const wantsViewport = action === 'wheel' || action === 'mousedown' || action === 'mouseup'
      || (action === 'move' && extra.dragging === true);
    if (wantsViewport && Number.isFinite(viewportX) && Number.isFinite(viewportY)) {
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
    const clickCount = Math.max(1, Math.min(3, event.detail || 1));
    if (button === 'left') this.replay.optimisticToggle?.(target.node);
    this.command('click', target, { button, clickCount });
    // The remote focus event selects the final field after React/label handlers.
    // Optimistically open the IME-capable local editor for ordinary fields.
    this.focus(target.nodeId, false);
    if (this.editor.hidden && this.select.hidden) {
      this.surface.focus({ preventScroll: true });
    } else if (button === 'left' && clickCount === 3 && !this.editor.hidden && !this.incremental && !this.password && this.target?.nodeId === target.nodeId) {
      try { this.editor.setSelectionRange(0, this.editor.value.length); } catch {}
    }
    this.localFocusUntil = !this.editor.hidden ? performance.now() + 300 : 0;
  }

  syncInputSelection({ id, start, end } = {}) {
    if (!this.enabled || this.editor.hidden || this.incremental || this.password) return;
    if (this.target?.nodeId !== id) return;
    const max = this.editor.value.length;
    const s = Math.max(0, Math.min(max, Number.isInteger(start) ? start : 0));
    const e = Math.max(s, Math.min(max, Number.isInteger(end) ? end : s));
    try { this.editor.setSelectionRange(s, e); } catch {}
  }

  focus(id, fromRemote = true) {
    if (!this.enabled || !this.replay) return;
    const node = this.replay.node(id);
    const target = this.replay.target(node);
    if (!node || !target) return;
    if (fromRemote && !this.editor.hidden && this.target && this.target.nodeId !== id && performance.now() < (this.localFocusUntil || 0)) {
      const currentNode = this.replay.node(this.target.nodeId);
      if (!currentNode || (!currentNode.contains?.(node) && !node.contains?.(currentNode))) return;
    }
    if (this.target?.nodeId === id && !this.editor.hidden && this.editor === document.activeElement) return;
    this.target = target;
    const editable = node.tagName === 'SELECT' || node.isContentEditable || (['INPUT', 'TEXTAREA'].includes(node.tagName) &&
      !['hidden', 'file', 'radio', 'checkbox', 'submit', 'button', 'range', 'color'].includes(node.type));
    if (!editable || node.disabled || node.readOnly) { this.hideEditor(); return; }
    // Passwords are masked by the recorder; contenteditable rich-text and
    // multiline/code-editor textareas lose formatting, newlines or cursor
    // position under full fill(). Use incremental insertText + key forwarding.
    this.password = node.type === 'password';
    this.contentEditable = node.isContentEditable;
    this.singleLine = node.tagName === 'INPUT';
    const control = node.tagName === 'SELECT' ? this.select : this.editor;
    this.editor.hidden = control !== this.editor;
    this.select.hidden = control !== this.select;
    const rect = node.getBoundingClientRect();
    const frameRect = this.replay.player.iframe.getBoundingClientRect();
    const surfaceRect = this.surface.getBoundingClientRect();
    const scale = frameRect.width / this.replay.width;
    let win = node.ownerDocument.defaultView;
    const nodeStyle = (() => { try { return win?.getComputedStyle(node) || null; } catch { return null; } })();
    const isTransparentColor = value => !value || value === 'transparent'
      || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0(?:\.0+)?\s*\)$/i.test(value);
    const scaledWidth = rect.width * scale;
    const scaledHeight = rect.height * scale;
    const isProxyInput = control === this.editor && (
      scaledWidth < 24 || scaledHeight < 14
      || parseFloat(nodeStyle?.opacity ?? '1') <= 0.05
      || nodeStyle?.visibility === 'hidden'
      || nodeStyle?.pointerEvents === 'none'
      || (node.tagName === 'INPUT' && isTransparentColor(nodeStyle?.backgroundColor)
        && parseFloat(nodeStyle?.borderTopWidth || '0') === 0
        && parseFloat(nodeStyle?.borderBottomWidth || '0') === 0
        && Boolean(node.closest?.('[role="combobox"], .arco-select, .ant-select, .semi-select, .el-select')))
    );
    this.incremental = this.password || this.contentEditable || node.tagName === 'TEXTAREA';
    if (control === this.select) {
      this.select.replaceChildren(...[...node.options].map(option => {
        const copy = document.createElement('option');
        copy.textContent = option.textContent;
        copy.value = option.value;
        copy.disabled = option.disabled;
        return copy;
      }));
      this.select.value = node.value;
    } else this.editor.value = this.incremental ? '' : (node.value || '');
    this.editor.setAttribute('aria-label', this.password ? '远端密码输入（不回传密码画面）' : '远端网页输入');
    this.editor.dataset.password = String(this.password);
    this.editor.dataset.incremental = String(this.incremental);
    this.editor.style.webkitTextSecurity = this.password ? 'disc' : 'none';
    const resolveBg = el => {
      let cur = el;
      for (let d = 0; cur && d < 12; d++) {
        try {
          const bg = cur.ownerDocument?.defaultView?.getComputedStyle(cur)?.backgroundColor;
          if (bg && !isTransparentColor(bg)) return bg;
        } catch { break; }
        cur = cur.parentElement;
      }
      return '#ffffff';
    };
    this.proxyInput = isProxyInput;
    if (!this.applyControlGeometry(control, node, nodeStyle, isProxyInput, resolveBg, isTransparentColor)) {
      this.hideEditor();
      return;
    }
    control.hidden = false;
    control.focus({ preventScroll: true });
    if (control === this.editor) this.editor.setSelectionRange(this.editor.value.length, this.editor.value.length);
    this.previousValue = this.editor.value;
  }

  applyControlGeometry(control, node, nodeStyle, isProxyInput, resolveBg = null, isTransparentColor = null) {
    if (!this.replay?.player?.iframe || !node?.isConnected) return false;
    const rect = node.getBoundingClientRect();
    const frameRect = this.replay.player.iframe.getBoundingClientRect();
    const surfaceRect = this.surface.getBoundingClientRect();
    if (!frameRect.width || !this.replay.width) return false;
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
    } catch { return false; }
    const scaledWidth = rect.width * scale;
    const scaledHeight = rect.height * scale;
    control.style.left = `${Math.max(0, frameRect.left - surfaceRect.left + left * scale)}px`;
    control.style.top = `${Math.max(0, frameRect.top - surfaceRect.top + top * scale)}px`;
    if (control === this.select) {
      control.style.width = `${Math.min(surfaceRect.width, Math.max(45, scaledWidth))}px`;
      control.style.height = `${Math.max(25, scaledHeight)}px`;
      return true;
    }
    control.dataset.ghost = String(Boolean(isProxyInput));
    const w = isProxyInput ? Math.max(2, Math.min(surfaceRect.width, scaledWidth)) : Math.min(surfaceRect.width, Math.max(12, scaledWidth));
    const h = Math.max(16, scaledHeight);
    control.style.width = `${w}px`;
    control.style.height = `${h}px`;
    if (nodeStyle) {
      const rawFontSize = parseFloat(nodeStyle.fontSize || '14');
      const fontSize = Number.isFinite(rawFontSize) ? Math.max(10, rawFontSize * scale) : 14;
      const rawLineHeight = parseFloat(nodeStyle.lineHeight || '');
      control.style.fontFamily = nodeStyle.fontFamily || 'sans-serif';
      control.style.fontSize = `${fontSize}px`;
      control.style.fontWeight = nodeStyle.fontWeight || '400';
      control.style.lineHeight = Number.isFinite(rawLineHeight) ? `${Math.max(12, rawLineHeight * scale)}px` : '1.35';
      control.style.textAlign = nodeStyle.textAlign || 'left';
      control.style.whiteSpace = node.tagName === 'INPUT' ? 'nowrap' : 'pre-wrap';
      const pad = prop => `${Math.max(0, (parseFloat(nodeStyle[prop] || '0') || 0) * scale)}px`;
      control.style.padding = isProxyInput ? '0' : `${pad('paddingTop')} ${pad('paddingRight')} ${pad('paddingBottom')} ${pad('paddingLeft')}`;
      control.style.borderRadius = nodeStyle.borderRadius || '0px';
      const transparent = isTransparentColor || (v => !v || v === 'transparent' || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0(?:\.0+)?\s*\)$/i.test(v));
      const fg = nodeStyle.color && !transparent(nodeStyle.color) ? nodeStyle.color : '#141418';
      const bg = resolveBg ? resolveBg(node) : '#ffffff';
      control.style.setProperty('--editor-fg', fg);
      control.style.setProperty('--editor-bg', bg);
      control.style.caretColor = (isProxyInput || this.incremental) ? 'transparent' : fg;
    }
    return true;
  }

  repositionEditor() {
    if (!this.enabled || !this.replay || !this.target) return;
    const control = !this.editor.hidden ? this.editor : (!this.select.hidden ? this.select : null);
    if (!control) return;
    const node = this.replay.node(this.target.nodeId);
    if (!node || !node.isConnected) { this.hideEditor(); return; }
    const rect = node.getBoundingClientRect();
    if (!this.proxyInput && rect.width < 1 && rect.height < 1) { this.hideEditor(); return; }
    if (!this.applyControlGeometry(control, node, null, this.proxyInput)) this.hideEditor();
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
    if (this.incremental) {
      const value = this.editor.value;
      if (value) {
        this.command('text', this.target, { value: value.slice(0, 16384) });
        this.editor.value = '';
        this.previousValue = '';
      }
      return;
    }
    this.command('input', this.target, { value: this.editor.value.slice(0, 16384),
      selectionStart: this.editor.selectionStart, selectionEnd: this.editor.selectionEnd });
  }

  forwardKey(event) {
    if (!this.enabled || !this.target) return;
    const modifiers = [];
    if (event.ctrlKey) modifiers.push('Control');
    if (event.metaKey) modifiers.push('Meta');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    this.command('key', this.target, { key: event.key === ' ' ? 'Space' : event.key, modifiers });
  }

  key(event, inEditor = false) {
    if (!this.enabled || event.isComposing) return;
    const isCopy = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c';
    if (isCopy) {
      if (inEditor && !this.incremental) return;
      if (this.onCopy) {
        event.preventDefault();
        const localText = this.replay?.getSelectedText?.() || '';
        const keySpec = { ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, key: event.key };
        this.onCopy({ localText, fallback: this.target ? () => this.forwardKey(keySpec) : null });
        return;
      }
    }
    if (!this.target) return;
    const modified = event.ctrlKey || event.metaKey || event.altKey;
    if (inEditor && !this.incremental && (event.ctrlKey || event.metaKey) && /^[acvxyz]$/i.test(event.key)) return;
    if (inEditor && this.incremental && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
    const special = SPECIAL_KEYS.has(event.key) || (inEditor && this.incremental && event.key === 'Backspace');
    if (inEditor && !modified && !special) return;
    if (!special && !modified && event.key.length !== 1) return;
    if (inEditor && !this.incremental && ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) && !modified) return;
    event.preventDefault();
    if (!modified && event.key.length === 1) this.command('text', this.target, { value: event.key });
    else this.forwardKey(event);
    if (this.password && ['Backspace', 'Delete'].includes(event.key)) {
      this.editor.value = this.editor.value.slice(0, -1);
      this.previousValue = this.editor.value;
    }
    if (event.key === 'Escape' || event.key === 'Tab' || (event.key === 'Enter' && this.singleLine)) this.hideEditor();
  }

  isEditing() {
    return Boolean((!this.editor.hidden && document.activeElement === this.editor)
      || (!this.select.hidden && document.activeElement === this.select));
  }

  hideEditor() {
    this.editor.hidden = true;
    this.editor.classList.remove('is-composing');
    this.editor.dataset.ghost = 'false';
    this.editor.dataset.incremental = 'false';
    this.select.hidden = true;
    this.select.replaceChildren();
    this.editor.value = '';
    this.previousValue = '';
    this.composing = false;
    this.incremental = false;
    this.proxyInput = false;
    this.singleLine = false;
  }
}
