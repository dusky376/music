import { on } from '../core/bus.js';
import { store } from '../core/state.js';
import { activateDialog, deactivateDialog } from './dialog.js';
import { loadComments } from './comments.js';
import { ensureLyrics, scrollLyricsToCurrent } from './lyrics.js';
import { closeQueue } from './queue.js';
import { loadSimilar, resetSimilar } from './similar.js';
import { showToast } from './toast.js';

const panel = document.getElementById('immersiveDisplay');
const dismissBtn = document.getElementById('dismissModalBtn');
const lyricsBtn = document.getElementById('switchLyricsBtn');
const commentsBtn = document.getElementById('switchCommentsBtn');
const similarBtn = document.getElementById('switchSimilarBtn');
const switcher = document.querySelector('.modal-switcher');
const lyricsViewport = document.getElementById('lyricsViewport');
const commentsStream = document.getElementById('commentsStream');
const similarStream = document.getElementById('similarStream');
const brief = document.getElementById('dockTrackBrief');
const lyricDockBtn = document.getElementById('dockLyricBtn');
const commentDockBtn = document.getElementById('dockCommentBtn');
const tabs = [lyricsBtn, commentsBtn, similarBtn];
const tabNames = ['lyrics', 'comments', 'similar'];
let commentsLoadedFor = '';
let similarLoadedFor = '';

function setTab(tab) {
  const allowed = tab === 'comments' || tab === 'similar' ? tab : 'lyrics';
  store.activeRightTab = allowed;
  const isLyrics = allowed === 'lyrics';
  const isComments = allowed === 'comments';
  const isSimilar = allowed === 'similar';
  lyricsBtn?.classList.toggle('active', isLyrics);
  commentsBtn?.classList.toggle('active', isComments);
  similarBtn?.classList.toggle('active', isSimilar);
  // aria-selected 与 roving tabindex 同步：只有选中 tab 进入 Tab 序列
  lyricsBtn?.setAttribute('aria-selected', String(isLyrics));
  lyricsBtn?.setAttribute('tabindex', isLyrics ? '0' : '-1');
  commentsBtn?.setAttribute('aria-selected', String(isComments));
  commentsBtn?.setAttribute('tabindex', isComments ? '0' : '-1');
  similarBtn?.setAttribute('aria-selected', String(isSimilar));
  similarBtn?.setAttribute('tabindex', isSimilar ? '0' : '-1');
  if (lyricsViewport) lyricsViewport.hidden = !isLyrics;
  if (commentsStream) commentsStream.hidden = !isComments;
  if (similarStream) similarStream.hidden = !isSimilar;

  if (isLyrics) {
    ensureLyrics(store.currentTrack);
    requestAnimationFrame(scrollLyricsToCurrent);
    return;
  }
  if (!store.currentTrack) return;
  if (isComments) {
    if (commentsLoadedFor !== store.currentTrack.id) {
      commentsLoadedFor = store.currentTrack.id;
      loadComments(store.currentTrack);
    }
    return;
  }
  // similar
  if (similarLoadedFor !== store.currentTrack.id) {
    similarLoadedFor = store.currentTrack.id;
    loadSimilar(store.currentTrack);
  }
}

export function openImmersive(tab = 'lyrics') {
  if (!store.currentTrack) {
    showToast('先选一首歌，再打开歌词页');
    return;
  }
  if (store.queuePanelOpen) closeQueue();
  store.immersiveOpen = true;
  panel?.classList.add('active');
  panel?.setAttribute('aria-hidden', 'false');
  document.body.classList.add('immersive-open');
  setTab(tab);
  // 焦点移入 / Tab 循环 / 底层 inert 交给共享基座，移除手写 lastFocus
  activateDialog(panel, { initialFocus: dismissBtn });
}

export function closeImmersive() {
  if (!store.immersiveOpen) return;
  store.immersiveOpen = false;
  panel?.classList.remove('active');
  panel?.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('immersive-open');
  deactivateDialog(panel);
}

export function toggleImmersive(tab = 'lyrics') {
  if (store.immersiveOpen) closeImmersive();
  else openImmersive(tab);
}

// tablist 方向键：Left/Right/Home/End 切换并同步 aria-selected
function handleTabKeys(event) {
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  let next = -1;
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  else return;
  event.preventDefault();
  // 阻止冒泡到全局快捷键监听，避免左右键同时触发快退 / 快进
  event.stopPropagation();
  setTab(tabNames[next]);
  tabs[next]?.focus();
}

export function initImmersive() {
  dismissBtn?.addEventListener('click', closeImmersive);
  switcher?.addEventListener('keydown', handleTabKeys);
  lyricsBtn?.addEventListener('click', () => setTab('lyrics'));
  commentsBtn?.addEventListener('click', () => setTab('comments'));
  similarBtn?.addEventListener('click', () => setTab('similar'));
  brief?.addEventListener('click', () => openImmersive('lyrics'));
  // 底部歌曲信息支持键盘打开；收藏按钮聚焦时按下 Enter/Space 不应触发。
  brief?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target !== brief) return;
    event.preventDefault();
    event.stopPropagation();
    openImmersive('lyrics');
  });
  lyricDockBtn?.addEventListener('click', () => openImmersive('lyrics'));
  commentDockBtn?.addEventListener('click', () => openImmersive('comments'));

  on('player:track', ({ track }) => {
    if (!store.immersiveOpen) return;
    commentsLoadedFor = '';
    similarLoadedFor = '';
    if (track) resetSimilar();
    if (store.activeRightTab === 'comments' && track) {
      commentsLoadedFor = track.id;
      loadComments(track);
    }
    if (store.activeRightTab === 'similar' && track) {
      similarLoadedFor = track.id;
      loadSimilar(track);
    }
    if (store.activeRightTab === 'lyrics') requestAnimationFrame(scrollLyricsToCurrent);
  });
}
