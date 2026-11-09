/**
 * 统一的模态弹窗焦点管理。
 *
 * 现有四个 dialog（登录、快捷键、播放队列、沉浸页）各自负责 class / aria-hidden，
 * 这里只补三件它们共同缺失的事：焦点移入与恢复、Tab 循环、底层 inert。
 *
 * 用法（各模块在自己的 open / close 末尾各调一次即可）：
 *   import { activateDialog, deactivateDialog } from './dialog.js';
 *   activateDialog(overlay, { initialFocus: closeBtn });
 *   deactivateDialog(overlay);
 */

const NON_UI_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'AUDIO', 'VIDEO', 'NOSCRIPT', 'TEMPLATE']);
const activeDialogs = new Set();
const previousFocus = new WeakMap();
const keepVisible = new WeakMap();
const keyHandlers = new WeakMap();

function focusables(root) {
  return [
    ...root.querySelectorAll(
      'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ),
  ].filter((node) => {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return false;
    if (node.closest('[hidden]')) return false;
    return Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
  });
}

function applyInert() {
  for (const child of document.body.children) {
    if (NON_UI_TAGS.has(child.tagName)) continue;
    let keep = false;
    for (const dialog of activeDialogs) {
      if (dialog === child || dialog.contains(child) || child.contains(dialog)) {
        keep = true;
        break;
      }
    }
    if (!keep) {
      for (const dialog of activeDialogs) {
        for (const extra of keepVisible.get(dialog) || []) {
          if (extra === child || extra.contains(child)) {
            keep = true;
            break;
          }
        }
        if (keep) break;
      }
    }
    child.inert = activeDialogs.size > 0 && !keep;
  }
}

/**
 * @param {HTMLElement} dialog 弹窗根元素
 * @param {{ initialFocus?: HTMLElement|null, keep?: HTMLElement[] }} options
 *   keep —— 弹窗打开时仍需可交互的外部元素（例如播放队列的点击遮罩）
 */
export function activateDialog(dialog, { initialFocus = null, keep = [] } = {}) {
  if (!dialog) return;
  if (activeDialogs.has(dialog)) return;
  previousFocus.set(dialog, document.activeElement instanceof HTMLElement ? document.activeElement : null);
  keepVisible.set(dialog, keep);
  activeDialogs.add(dialog);

  const onKeydown = (event) => {
    if (event.key !== 'Tab') return;
    const items = focusables(dialog);
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    if (event.shiftKey && (current === first || !dialog.contains(current))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (current === last || !dialog.contains(current))) {
      event.preventDefault();
      first.focus();
    }
  };
  keyHandlers.set(dialog, onKeydown);
  dialog.addEventListener('keydown', onKeydown);
  applyInert();

  const target =
    initialFocus && dialog.contains(initialFocus) && !initialFocus.hasAttribute('hidden')
      ? initialFocus
      : focusables(dialog)[0];
  target?.focus?.({ preventScroll: true });
  if (!target) {
    dialog.setAttribute('tabindex', '-1');
    dialog.focus({ preventScroll: true });
  }
}

export function deactivateDialog(dialog) {
  if (!dialog || !activeDialogs.has(dialog)) return;
  activeDialogs.delete(dialog);
  const handler = keyHandlers.get(dialog);
  if (handler) dialog.removeEventListener('keydown', handler);
  keyHandlers.delete(dialog);
  applyInert();

  const restore = previousFocus.get(dialog);
  previousFocus.delete(dialog);
  if (restore?.isConnected && !restore.closest('[inert]')) {
    restore.focus({ preventScroll: true });
  }
}

export function isDialogOpen(dialog) {
  return Boolean(dialog && activeDialogs.has(dialog));
}
