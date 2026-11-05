import { adjustVolume, next, prev, seek, getCurrentTime, toggle, toggleMute } from '../core/player.js';
import { store, toggleFavorite } from '../core/state.js';
import { closeImmersive, toggleImmersive } from './immersive.js';
import { closeSidebar } from './nav.js';
import { closeQueue, toggleQueue } from './queue.js';
import { showToast } from './toast.js';

const overlay = document.getElementById('shortcutOverlay');
const helpBtn = document.getElementById('shortcutHelpBtn');

function openShortcuts() {
  if (!overlay) return;
  overlay.classList.add('active');
  overlay.setAttribute('aria-hidden', 'false');
  overlay.querySelector('.shortcut-panel')?.focus?.();
}

function closeShortcuts() {
  if (!overlay) return;
  overlay.classList.remove('active');
  overlay.setAttribute('aria-hidden', 'true');
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

function handleKeydown(event) {
  if (event.key === 'Escape') {
    if (overlay?.classList.contains('active')) {
      closeShortcuts();
      event.preventDefault();
      return;
    }
    if (store.immersiveOpen) {
      closeImmersive();
      event.preventDefault();
      return;
    }
    if (store.queuePanelOpen) {
      closeQueue();
      event.preventDefault();
      return;
    }
    if (document.body.classList.contains('sidebar-open')) {
      closeSidebar();
      event.preventDefault();
    }
    return;
  }

  if (isTypingTarget(event.target)) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  const key = event.key.toLowerCase();
  if (event.code === 'Space') {
    // 焦点在按钮上时保留原生 Space 语义（如收藏、静音），不吃掉成播放/暂停。
    if (event.target instanceof HTMLElement && event.target.tagName === 'BUTTON') return;
    event.preventDefault();
    toggle();
    return;
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    seek(getCurrentTime() + (event.shiftKey ? 30 : 5));
    return;
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    seek(getCurrentTime() - (event.shiftKey ? 30 : 5));
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    adjustVolume(0.05);
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    adjustVolume(-0.05);
    return;
  }
  if (key === 'm') {
    toggleMute();
    return;
  }
  if (key === 'l') {
    if (!store.currentTrack) {
      showToast('先选一首歌吧', 1400);
      return;
    }
    toggleFavorite(store.currentTrack);
    return;
  }
  if (key === 'f') {
    toggleImmersive('lyrics');
    return;
  }
  if (key === 'q') {
    if (store.immersiveOpen) return;
    toggleQueue();
    return;
  }
  if (key === '?' || (key === '/' && event.shiftKey)) {
    event.preventDefault();
    openShortcuts();
    return;
  }
  if (key === 'n') {
    next();
    return;
  }
  if (key === 'p') {
    prev();
  }
}

export function initShortcuts() {
  document.addEventListener('keydown', handleKeydown);
  helpBtn?.addEventListener('click', openShortcuts);
  overlay?.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('[data-close-shortcuts]')) closeShortcuts();
  });
  overlay?.setAttribute('aria-hidden', 'true');
  overlay?.querySelector('.shortcut-panel')?.setAttribute('tabindex', '-1');
}
