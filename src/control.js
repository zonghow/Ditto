import { InputError } from './snapshot.js';

const KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Space']);
const MODIFIERS = new Set(['Control', 'Meta', 'Alt', 'Shift']);
const TYPES = new Set(['click', 'move', 'wheel', 'text', 'key', 'input', 'select']);

export function validateControl(input) {
  if (!input || typeof input !== 'object' || !TYPES.has(input.action)) throw new InputError('不支持的远端操作。');
  if (typeof input.tabId !== 'string' || input.tabId.length > 100 || typeof input.documentId !== 'string' || input.documentId.length > 100) throw new InputError('缺少网页身份。');
  if (!Number.isInteger(input.nodeId) || input.nodeId < 1 || input.nodeId >= 1_000_000_000) throw new InputError('缺少有效的网页节点。');
  if (!Array.isArray(input.framePath) || input.framePath.length > 12 || input.framePath.some(id => !Number.isInteger(id) || id < 1 || id >= 1_000_000_000)) throw new InputError('网页 frame 路径无效。');
  const clean = { action: input.action, tabId: input.tabId, documentId: input.documentId, nodeId: input.nodeId, framePath: input.framePath };
  if (['click', 'move', 'wheel'].includes(input.action)) {
    if (![input.offsetX, input.offsetY].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new InputError('操作位置无效。');
    clean.offsetX = input.offsetX;
    clean.offsetY = input.offsetY;
  }
  if (input.action === 'click') {
    clean.button = input.button ?? 'left';
    clean.clickCount = input.clickCount ?? 1;
    if (!['left', 'middle', 'right'].includes(clean.button) || ![1, 2].includes(clean.clickCount)) throw new InputError('鼠标操作无效。');
  }
  if (input.action === 'wheel') {
    if (![input.deltaX, input.deltaY].every(value => Number.isFinite(value) && Math.abs(value) <= 4000)) throw new InputError('滚动量无效。');
    clean.deltaX = input.deltaX;
    clean.deltaY = input.deltaY;
    if (input.viewportX !== undefined || input.viewportY !== undefined) {
      if (![input.viewportX, input.viewportY].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
        throw new InputError('操作位置无效。');
      }
      clean.viewportX = input.viewportX;
      clean.viewportY = input.viewportY;
    }
  }
  if (['text', 'input', 'select'].includes(input.action)) {
    if (typeof input.value !== 'string' || input.value.length > 16384) throw new InputError('输入过长或格式无效。');
    clean.value = input.value;
    if (input.action === 'text' && input.appendToPassword === true) clean.appendToPassword = true;
    if (input.selectionStart !== undefined || input.selectionEnd !== undefined) {
      if (![input.selectionStart, input.selectionEnd].every(value => Number.isInteger(value) && value >= 0 && value <= input.value.length)) throw new InputError('输入光标位置无效。');
      clean.selectionStart = input.selectionStart;
      clean.selectionEnd = input.selectionEnd;
    }
  }
  if (input.action === 'key') {
    if (typeof input.key !== 'string' || !(KEYS.has(input.key) || /^[a-z0-9]$/i.test(input.key))) throw new InputError('不支持这个按键。');
    if (!Array.isArray(input.modifiers) || input.modifiers.length > 4 || input.modifiers.some(modifier => !MODIFIERS.has(modifier))) throw new InputError('组合键无效。');
    if (input.modifiers.some(modifier => ['Control', 'Meta'].includes(modifier)) &&
      !/^[acvxyz]$/i.test(input.key) && !['Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(input.key)) {
      throw new InputError('浏览器级快捷键不在网页操作范围内。');
    }
    clean.key = input.key;
    clean.modifiers = [...new Set(input.modifiers)];
  }
  return clean;
}

export class ControlLease {
  owner = null;
  acquiredAt = null;
  expiresAt = 0;
  revision = 0;

  constructor(onChange = () => {}, now = Date.now) {
    this.onChange = onChange;
    this.now = now;
  }

  acquire(id) {
    this.expire();
    if (this.owner && this.owner !== id) throw new InputError('另一个观测窗口正在接管，请先在那里释放操作。', 409);
    this.owner = id;
    this.acquiredAt ||= new Date(this.now()).toISOString();
    this.expiresAt = this.now() + 45000;
    this.revision++;
    this.onChange();
  }

  require(id) {
    this.expire();
    if (!this.owner || this.owner !== id) throw new InputError('请先接管操作；只读窗口不能控制远端。', 403);
    this.expiresAt = this.now() + 45000;
    return this.revision;
  }

  release(id) {
    if (this.owner && (id === undefined || id === this.owner)) {
      this.owner = null;
      this.acquiredAt = null;
      this.expiresAt = 0;
      this.revision++;
      this.onChange();
    }
  }

  expire() { if (this.owner && this.now() >= this.expiresAt) this.release(); }
  summary() { return { owner: this.owner, acquiredAt: this.acquiredAt }; }
}
