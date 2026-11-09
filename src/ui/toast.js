import { on } from '../core/bus.js';

const container = document.getElementById('toastContainer');
const MAX_TOASTS = 3;
const MIN_DURATION = 2200;
const DEDUPE_WINDOW = 1200;
const lastShown = new Map();

export function showToast(message, duration = 2600, tone = 'default', action = null) {
  if (!container || !message) return;
  const now = Date.now();
  // 相同文案在 1200ms 内只弹一次，避免 online/offline 抖动与续播提示堆多条。
  const last = lastShown.get(message) || 0;
  if (now - last < DEDUPE_WINDOW) return;
  lastShown.set(message, now);
  // 顺带清理过期记录，避免 Map 无限增长。
  for (const [key, time] of lastShown) {
    if (now - time >= DEDUPE_WINDOW) lastShown.delete(key);
  }
  while (container.children.length >= MAX_TOASTS) {
    container.firstElementChild?.remove();
  }
  const toast = document.createElement('div');
  toast.className = `toast-msg${tone === 'error' ? ' is-error' : ''}`;
  toast.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  toast.appendChild(text);

  const remove = () => {
    if (!toast.isConnected) return;
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 260);
  };
  let timer = setTimeout(remove, Math.max(MIN_DURATION, duration));

  if (action?.label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      clearTimeout(timer);
      timer = 0;
      remove();
      action.onClick?.();
    });
    toast.appendChild(button);
    // 带操作按钮的提示多留几秒，别让用户来得及反应就消失。
    clearTimeout(timer);
    timer = setTimeout(remove, Math.max(3200, duration));
  }

  toast.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
  container.appendChild(toast);
}

export function initToast() {
  on('toast', ({ message, duration, tone }) => showToast(message, duration, tone));
}
