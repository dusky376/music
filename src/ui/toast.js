import { on } from '../core/bus.js';

const container = document.getElementById('toastContainer');
const MAX_TOASTS = 3;

export function showToast(message, duration = 2600, tone = 'default', action = null) {
  if (!container || !message) return;
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
  let timer = setTimeout(remove, Math.max(1400, duration));

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
