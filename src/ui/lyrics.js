import { getLyric } from '../core/api.js';
import { on } from '../core/bus.js';
import { findLyricIndex, parseLyrics } from '../core/lyrics.js';
import { getCurrentTime, seek, toggle } from '../core/player.js';
import { store } from '../core/state.js';

const viewport = document.getElementById('lyricsViewport');
const trackEl = document.getElementById('lyricsTrack');
let lines = [];
let activeIndex = -1;
let requestToken = 0;
let controller = null;
let userScrollUntil = 0;
let autoScrollUntil = 0;
let loadedFor = '';
let prefetchTimer = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showMessage(title, detail, action) {
  trackEl.replaceChildren();
  const box = el('div', 'lyrics-state');
  box.appendChild(el('div', 'lyrics-state-icon', '♪'));
  box.appendChild(el('h3', '', title));
  if (detail) box.appendChild(el('p', '', detail));
  if (action) {
    const button = el('button', 'ghost-button', action.label);
    button.type = 'button';
    button.addEventListener('click', action.onClick);
    box.appendChild(button);
  }
  trackEl.appendChild(box);
  lines = [];
  activeIndex = -1;
  viewport.scrollTop = 0;
}

function createLine(line, index) {
  const phrase = el('button', 'lyric-phrase');
  phrase.type = 'button';
  phrase.dataset.index = String(index);
  phrase.appendChild(el('span', 'lyric-original', line.text));
  if (line.translation) phrase.appendChild(el('span', 'lyric-translation', line.translation));
  phrase.addEventListener('click', () => {
    if (!store.currentTrack) return;
    if (store.status !== 'playing') toggle();
    seek(line.time);
    scrollToActive(true);
  });
  return phrase;
}

function renderLyrics(nextLines) {
  lines = nextLines;
  activeIndex = -1;
  trackEl.replaceChildren();
  viewport.scrollTop = 0;
  if (!lines.length) {
    showMessage('没有找到歌词', '这首歌可能是纯音乐，或者歌词还没有上传。');
    return;
  }
  const fragment = document.createDocumentFragment();
  lines.forEach((line, index) => fragment.appendChild(createLine(line, index)));
  trackEl.appendChild(fragment);
}

function updateClasses(index) {
  const phrases = trackEl.querySelectorAll('.lyric-phrase');
  phrases.forEach((phrase, i) => {
    const diff = Math.abs(i - index);
    phrase.classList.toggle('active', i === index);
    phrase.classList.toggle('depth-1', diff === 1);
    phrase.classList.toggle('depth-2', diff === 2);
    phrase.classList.toggle('depth-3', diff >= 3);
    if (i === index) phrase.setAttribute('aria-current', 'true');
    else phrase.removeAttribute('aria-current');
  });
}

function scrollToActive(force = false) {
  if (!lines.length || activeIndex < 0) return;
  if (!store.immersiveOpen || store.activeRightTab !== 'lyrics') return;
  const now = Date.now();
  if (!force && now < userScrollUntil) return;
  const phrase = trackEl.querySelector(`.lyric-phrase[data-index="${activeIndex}"]`);
  if (!phrase) return;
  const target = Math.max(0, phrase.offsetTop + phrase.offsetHeight / 2 - viewport.clientHeight / 2);
  autoScrollUntil = now + 1200;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  viewport.scrollTo({ top: target, behavior: force || reduced ? 'auto' : 'smooth' });
}

function sync(time) {
  if (!lines.length) return;
  const index = findLyricIndex(lines, time);
  if (index === activeIndex) return;
  activeIndex = index;
  store.currentLyricIdx = index;
  updateClasses(index);
  if (index >= 0) scrollToActive();
}

async function loadFor(track) {
  const token = ++requestToken;
  controller?.abort();
  controller = new AbortController();
  if (!track) {
    loadedFor = '';
    showMessage('还没有播放歌曲', '选一首歌，歌词会在这里出现。');
    return;
  }
  loadedFor = String(track.id);
  showMessage('正在同步歌词…', track.name);
  try {
    const data = await getLyric(track.id, { signal: controller.signal });
    if (token !== requestToken) return;
    const parsed = parseLyrics(data.lrc, data.tlyric, data.yrc);
    store.lyrics = parsed;
    renderLyrics(parsed);
    sync(getCurrentTime());
    scrollToActive(true);
  } catch (error) {
    if (token !== requestToken || error?.code === 'ABORTED') return;
    loadedFor = '';
    showMessage('歌词没有加载出来', '网络波动时可以点这里重试。', {
      label: '重新加载歌词',
      onClick: () => loadFor(track),
    });
  }
}

/** 打开歌词页时调用：同曲已加载就复用，避免重复请求。 */
export function ensureLyrics(track = store.currentTrack) {
  clearTimeout(prefetchTimer);
  prefetchTimer = 0;
  if (!track) {
    if (loadedFor) {
      loadedFor = '';
      showMessage('还没有播放歌曲', '选一首歌，歌词会在这里出现。');
    }
    return;
  }
  if (loadedFor === String(track.id)) {
    sync(getCurrentTime());
    return;
  }
  loadFor(track);
}

function scheduleLyrics(track) {
  clearTimeout(prefetchTimer);
  prefetchTimer = 0;
  if (!track) {
    ensureLyrics(null);
    return;
  }
  if (store.status === 'error') return;
  if (loadedFor === String(track.id)) return;
  if (store.immersiveOpen) {
    // 沉浸页打开时只在歌词页签下请求，避免用户看评论时白等一次。
    if (store.activeRightTab === 'lyrics') ensureLyrics(track);
    return;
  }
  // 关闭状态下延迟预取：快速切歌不会为每首歌都发歌词请求。
  prefetchTimer = setTimeout(() => ensureLyrics(track), 1200);
}

export function refreshActiveLyric() {
  sync(getCurrentTime());
}

export function scrollLyricsToCurrent() {
  scrollToActive(true);
}

export function initLyrics() {
  on('player:track', ({ track }) => scheduleLyrics(track));
  on('player:tick', ({ current }) => sync(current));
  on('player:state', () => {
    if (store.status === 'paused' || store.status === 'error') sync(getCurrentTime());
  });

  viewport?.addEventListener(
    'wheel',
    () => {
      userScrollUntil = Date.now() + 3200;
    },
    { passive: true }
  );
  viewport?.addEventListener(
    'touchstart',
    () => {
      userScrollUntil = Date.now() + 3200;
    },
    { passive: true }
  );
  viewport?.addEventListener('scroll', () => {
    if (Date.now() > autoScrollUntil) userScrollUntil = Date.now() + 3200;
  }, { passive: true });

  showMessage('还没有播放歌曲', '选一首歌，歌词会在这里出现。');
}
