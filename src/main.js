import { loadSettings, store } from './core/state.js';
import { formatTime } from './core/format.js';
import * as player from './core/player.js';
import { initAmbient } from './ui/ambient.js';
import { initImmersive } from './ui/immersive.js';
import { initLogin } from './ui/login.js';
import { initLyrics } from './ui/lyrics.js';
import { initNav } from './ui/nav.js';
import { initPlayerbar } from './ui/playerbar.js';
import { initQueue } from './ui/queue.js';
import { initSearch } from './ui/search.js';
import { initShortcuts } from './ui/shortcuts.js';
import { initToast, showToast } from './ui/toast.js';
import { initTracklist } from './ui/tracklist.js';

function installDiagnostics() {
  const errors = [];
  window.addEventListener('error', (event) => {
    errors.push({
      type: 'error',
      message: event.message,
      source: event.filename,
      line: event.lineno,
      time: new Date().toISOString(),
    });
    if (errors.length > 20) errors.shift();
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    if (reason?.code === 'ABORTED' || reason?.name === 'AbortError') return;
    errors.push({
      type: 'unhandledrejection',
      message: reason?.message || String(reason),
      time: new Date().toISOString(),
    });
    if (errors.length > 20) errors.shift();
  });
  window.__PURETONE__ = {
    store,
    player,
    errors,
    version: '1.0.0',
  };
}

function boot() {
  loadSettings();
  installDiagnostics();

  initToast();
  initAmbient();
  initTracklist();
  initLyrics();
  initPlayerbar();
  initQueue();
  initImmersive();
  initLogin();
  initSearch();
  initShortcuts();

  player.init();
  const restored = player.restore();
  if (restored && restored.position > 5) {
    // 一次性轻提示：告诉他"上次听到哪里了"，一键续播，不打扰。
    setTimeout(() => {
      showToast(
        `上次听到《${restored.track.name}》${formatTime(restored.position)}`,
        5200,
        'default',
        { label: '继续播放', onClick: () => player.toggle() }
      );
    }, 1500);
  }
  initNav();

  window.addEventListener('offline', () => showToast('网络已断开，正在显示可用的缓存', 3200));
  window.addEventListener('online', () => showToast('网络已恢复', 1800));

  document.documentElement.classList.add('app-ready');
  window.__PT_READY__ = true;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
