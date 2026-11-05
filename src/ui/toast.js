import { on } from '../core/bus.js';

const container = document.getElementById('toastContainer');
const MAX_TOASTS = 3;

export function showToast(message, duration = 2600, tone = 'default') {
  if (!container || !message) return;
  while (container.children.length >= MAX_TOASTS) {
    container.firstElementChild?.remove();
  }
  const toast = document.createElement('div');
  toast.className = `toast-msg${tone === 'error' ? ' is-error' : ''}`;
  toast.setAttribute('role', 'status');
  toast.textContent = message;
  container.appendChild(toast);

  const remove = () => {
    if (!toast.isConnected) return;
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 260);
  };
  const timer = setTimeout(remove, Math.max(1200, duration));
  toast.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
}

export function initToast() {
  on('toast', ({ message, duration, tone }) => showToast(message, duration, tone));
}
