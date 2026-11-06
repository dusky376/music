import { on } from '../core/bus.js';
import { store } from '../core/state.js';
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
const lyricsViewport = document.getElementById('lyricsViewport');
const commentsStream = document.getElementById('commentsStream');
const similarStream = document.getElementById('similarStream');
const brief = document.getElementById('dockTrackBrief');
const lyricDockBtn = document.getElementById('dockLyricBtn');
const commentDockBtn = document.getElementById('dockCommentBtn');
let lastFocus = null;
let commentsLoadedFor = '';
let similarLoadedFor = '';

function setTab(tab) {
  const allowed = tab === 'comments' || tab === 'similar' ? tab : 'lyrics';
  store.activeRightTab = allowed;
  const isLyrics = allowed === 'lyrics';
  const isComments = allowed === 'comments';
  lyricsBtn?.classList.toggle('active', isLyrics);
  commentsBtn?.classList.toggle('active', isComments);
  similarBtn?.classList.toggle('active', allowed === 'similar');
  lyricsBtn?.setAttribute('aria-selected', String(isLyrics));
  commentsBtn?.setAttribute('aria-selected', String(isComments));
  similarBtn?.setAttribute('aria-selected', String(allowed === 'similar'));
  if (lyricsViewport) lyricsViewport.hidden = !isLyrics;
  if (commentsStream) commentsStream.hidden = !isComments;
  if (similarStream) similarStream.hidden = allowed !== 'similar';

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
  lastFocus = document.activeElement;
  store.immersiveOpen = true;
  panel?.classList.add('active');
  panel?.setAttribute('aria-hidden', 'false');
  document.body.classList.add('immersive-open');
  setTab(tab);
  setTimeout(() => dismissBtn?.focus({ preventScroll: true }), 120);
}

export function closeImmersive() {
  if (!store.immersiveOpen) return;
  store.immersiveOpen = false;
  panel?.classList.remove('active');
  panel?.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('immersive-open');
  if (lastFocus instanceof HTMLElement) lastFocus.focus({ preventScroll: true });
  lastFocus = null;
}

export function toggleImmersive(tab = 'lyrics') {
  if (store.immersiveOpen) closeImmersive();
  else openImmersive(tab);
}

export function initImmersive() {
  dismissBtn?.addEventListener('click', closeImmersive);
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
