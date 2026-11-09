import { on } from '../core/bus.js';
import { clamp, formatTime } from '../core/format.js';
import {
  adjustVolume,
  getCurrentTime,
  getDuration,
  hasResume,
  next,
  prev,
  seekRatio,
  setVolume,
  toggle,
  toggleMute,
  toggleShuffle,
} from '../core/player.js';
import { isFavorited, saveSettings, store, toggleFavorite } from '../core/state.js';
import { showToast } from './toast.js';

const FALLBACK = '/assets/cover.svg';

const refs = {
  dockArt: document.getElementById('dockArtImg'),
  dockTitle: document.getElementById('dockSongTitle'),
  dockAuthor: document.getElementById('dockSongAuthor'),
  fav: document.getElementById('dockFavBtn'),
  stageArt: document.getElementById('stageArtwork'),
  stageTitle: document.getElementById('stageTitle'),
  stageArtist: document.getElementById('stageArtist'),
  stageCover: document.getElementById('stageCoverFrame'),
  playBtn: document.getElementById('playBtn'),
  modalPlayBtn: document.getElementById('modalPlayBtn'),
  shuffle: document.getElementById('shuffleBtn'),
  prev: document.getElementById('prevBtn'),
  next: document.getElementById('nextBtn'),
  modalPrev: document.getElementById('modalPrevBtn'),
  modalNext: document.getElementById('modalNextBtn'),
  curr: document.getElementById('currTime'),
  dur: document.getElementById('durTime'),
  modalCurr: document.getElementById('modalCurrTime'),
  modalDur: document.getElementById('modalDurTime'),
  progressTrack: document.getElementById('progressTrack'),
  modalProgressTrack: document.getElementById('modalProgressTrack'),
  progressTooltip: document.getElementById('progressTooltip'),
  modalTooltip: document.getElementById('modalProgressTooltip'),
  volumeTrack: document.getElementById('volumeTrack'),
  volumeBar: document.getElementById('volumeBar'),
  muteBtn: document.getElementById('muteBtn'),
};

let draggingSeeker = false;
let dockTipTimer = 0;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const coverTimers = new WeakMap();

// 移动端首次成功播放后提示一次：封面可以点开看歌词。
function maybeDockTip() {
  if (window.matchMedia('(min-width: 841px)').matches) return;
  let shown = false;
  try {
    shown = localStorage.getItem('pt_tip_dock_lyrics') === '1';
  } catch {
    shown = false;
  }
  if (shown) return;
  try {
    localStorage.setItem('pt_tip_dock_lyrics', '1');
  } catch {
    // 存储不可用就每次轻提示，无碍播放。
  }
  clearTimeout(dockTipTimer);
  dockTipTimer = setTimeout(() => showToast('点封面看歌词', 3200), 1800);
}

// 仅在值变化时写 aria，避免 tick 每帧重写触发读屏反复播报。
function setAria(el, attr, value) {
  if (el && el.getAttribute(attr) !== String(value)) el.setAttribute(attr, String(value));
}

// 用两个 CSS 变量驱动：--ratio 给 scaleX，--progress 给 thumb 的 left。
// 避免 calc 里的乘法（老 Safari 支持不全），每帧只写变量、不触发布局。
function setRatio(track, ratio) {
  if (!track) return;
  const value = clamp(ratio, 0, 1);
  track.style.setProperty('--ratio', String(value));
  track.style.setProperty('--progress', `${value * 100}%`);
}

// 人类可读时长，用于 slider 的 aria-valuetext。
function humanTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes > 0 ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`;
}

function setCover(img, src) {
  if (!img) return;
  const nextSrc = src || FALLBACK;
  if (img.getAttribute('src') === nextSrc) return;
  const commit = () => {
    img.onerror = () => {
      img.onerror = null;
      img.src = FALLBACK;
    };
    img.src = nextSrc;
    img.classList.remove('cover-swapping');
  };
  if (reduceMotion) {
    commit();
    return;
  }
  // 先淡出约 200ms，换 src 后移除类再淡入约 200ms，合计约 400ms 交叉溶解。
  img.classList.add('cover-swapping');
  clearTimeout(coverTimers.get(img));
  coverTimers.set(img, setTimeout(commit, 200));
}

function updateFavorite() {
  const track = store.currentTrack;
  const favored = Boolean(track && isFavorited(track.id));
  refs.fav?.classList.toggle('favorited', favored);
  refs.fav?.setAttribute('aria-pressed', String(favored));
  refs.fav?.setAttribute('title', favored ? '取消喜欢' : '喜欢');
  const svg = refs.fav?.querySelector('svg');
  if (svg) {
    svg.style.fill = favored ? 'currentColor' : 'none';
    svg.style.stroke = favored ? 'none' : 'currentColor';
  }
}

// Play↔Pause 改为切换 class，由 CSS 做 morph；不再写 innerHTML。
function setPlayState(playing) {
  refs.playBtn?.classList.toggle('is-playing', playing);
  refs.modalPlayBtn?.classList.toggle('is-playing', playing);
}

function updateState() {
  const playing = store.status === 'playing';
  const loading = store.status === 'loading' || store.buffering;
  setPlayState(playing);
  refs.playBtn?.classList.toggle('is-loading', loading);
  refs.modalPlayBtn?.classList.toggle('is-loading', loading);
  refs.playBtn?.setAttribute('aria-label', playing ? '暂停' : '播放');
  refs.modalPlayBtn?.setAttribute('aria-label', playing ? '暂停' : '播放');
  refs.stageCover?.classList.toggle('playing', playing);
  refs.shuffle?.classList.toggle('active', store.shuffle);
  refs.shuffle?.setAttribute('aria-pressed', String(store.shuffle));
  refs.playBtn?.classList.toggle('has-error', store.status === 'error');
  refs.modalPlayBtn?.classList.toggle('has-error', store.status === 'error');
  updateFavorite();
}

function updateTrack() {
  const track = store.currentTrack;
  if (!track) {
    if (refs.dockTitle) refs.dockTitle.textContent = '未在播放';
    if (refs.dockAuthor) refs.dockAuthor.textContent = '从榜单中点选单曲开始畅听';
    setCover(refs.dockArt, FALLBACK);
    setCover(refs.stageArt, FALLBACK);
    if (refs.stageTitle) refs.stageTitle.textContent = '歌曲名称';
    if (refs.stageArtist) refs.stageArtist.textContent = '歌手 — 专辑';
    updateFavorite();
    return;
  }
  if (refs.dockTitle) refs.dockTitle.textContent = track.name;
  if (refs.dockAuthor) {
    refs.dockAuthor.textContent = hasResume() ? `${track.artist} · 上次播放` : track.artist;
  }
  setCover(refs.dockArt, track.cover);
  setCover(refs.stageArt, track.cover);
  if (refs.stageTitle) refs.stageTitle.textContent = track.name;
  if (refs.stageArtist) refs.stageArtist.textContent = `${track.artist} — ${track.album}`;
  updateFavorite();
}

function updateTick({ current = 0, duration = 0 }) {
  if (draggingSeeker) return;
  const safeDuration = Number(duration) || Number(store.currentTrack?.duration) || 0;
  const safeCurrent = clamp(Number(current) || 0, 0, safeDuration || Number.MAX_SAFE_INTEGER);
  const ratio = safeDuration > 0 ? safeCurrent / safeDuration : 0;
  setRatio(refs.progressTrack, ratio);
  setRatio(refs.modalProgressTrack, ratio);
  const wholePercent = Math.round(clamp(ratio, 0, 1) * 100);
  setAria(refs.progressTrack, 'aria-valuenow', wholePercent);
  setAria(refs.modalProgressTrack, 'aria-valuenow', wholePercent);
  const valueText = `${humanTime(safeCurrent)}，共 ${humanTime(safeDuration)}`;
  setAria(refs.progressTrack, 'aria-valuetext', valueText);
  setAria(refs.modalProgressTrack, 'aria-valuetext', valueText);
  if (refs.curr) refs.curr.textContent = formatTime(safeCurrent);
  if (refs.modalCurr) refs.modalCurr.textContent = formatTime(safeCurrent);
  if (refs.dur) refs.dur.textContent = formatTime(safeDuration);
  if (refs.modalDur) refs.modalDur.textContent = formatTime(safeDuration);
}

function updateVolume({ volume = store.volume, muted = store.muted } = {}) {
  const value = muted ? 0 : volume;
  if (refs.volumeBar) refs.volumeBar.style.width = `${clamp(value, 0, 1) * 100}%`;
  const wholePercent = Math.round(clamp(value, 0, 1) * 100);
  setAria(refs.volumeTrack, 'aria-valuenow', wholePercent);
  setAria(refs.volumeTrack, 'aria-valuetext', muted ? '已静音' : `音量 ${wholePercent}%`);
  if (refs.muteBtn) {
    refs.muteBtn.classList.toggle('active', muted);
    refs.muteBtn.setAttribute('aria-pressed', String(muted));
    refs.muteBtn.setAttribute('title', muted ? '取消静音' : '静音');
  }
}

function setupSeeker(track, tooltip) {
  if (!track) return;
  let pointerId = null;

  const ratioAt = (clientX) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return 0;
    return clamp((clientX - rect.left) / rect.width, 0, 1);
  };

  const preview = (ratio, clientX) => {
    draggingSeeker = true;
    setRatio(track, ratio);
    if (tooltip) {
      const duration = Number(store.currentTrack?.duration) || 0;
      tooltip.textContent = formatTime(ratio * duration);
      tooltip.style.left = `${ratio * 100}%`;
    }
    if (clientX !== undefined) {
      const rect = track.getBoundingClientRect();
      tooltip?.classList.toggle('visible', clientX >= rect.left && clientX <= rect.right);
    }
  };

  track.addEventListener('pointerdown', (event) => {
    if (!store.currentTrack) return;
    if (event.button !== undefined && event.button !== 0) return;
    pointerId = event.pointerId;
    track.setPointerCapture?.(pointerId);
    preview(ratioAt(event.clientX), event.clientX);
    event.preventDefault();
  });

  track.addEventListener('pointermove', (event) => {
    if (pointerId === null || event.pointerId !== pointerId) return;
    preview(ratioAt(event.clientX), event.clientX);
  });

  const finish = (event, commit) => {
    if (pointerId === null || (event.pointerId !== undefined && event.pointerId !== pointerId)) return;
    const ratio = ratioAt(event.clientX);
    track.releasePointerCapture?.(pointerId);
    pointerId = null;
    tooltip?.classList.remove('visible');
    draggingSeeker = false;
    if (commit) seekRatio(ratio);
    else updateTick({ current: getCurrentTime(), duration: getDuration() });
  };

  track.addEventListener('pointerup', (event) => finish(event, true));
  track.addEventListener('pointercancel', (event) => finish(event, false));
  track.addEventListener('lostpointercapture', () => {
    if (pointerId !== null) {
      pointerId = null;
      draggingSeeker = false;
      tooltip?.classList.remove('visible');
    }
  });
  track.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (!getDuration()) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 30 : 5);
    seekRatio((getCurrentTime() + delta) / getDuration());
  });
}

function setupVolume() {
  const track = refs.volumeTrack;
  if (!track) return;
  let pointerId = null;
  const ratioAt = (clientX) => {
    const rect = track.getBoundingClientRect();
    return rect.width ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0;
  };
  track.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    pointerId = event.pointerId;
    track.setPointerCapture?.(pointerId);
    setVolume(ratioAt(event.clientX));
    event.preventDefault();
  });
  track.addEventListener('pointermove', (event) => {
    if (pointerId === null || event.pointerId !== pointerId) return;
    setVolume(ratioAt(event.clientX));
  });
  const end = (event) => {
    if (pointerId === null) return;
    track.releasePointerCapture?.(pointerId);
    pointerId = null;
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  track.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    adjustVolume((event.key === 'ArrowLeft' ? -1 : 1) * 0.05);
  });
}

function bindButtons() {
  refs.playBtn?.addEventListener('click', toggle);
  refs.modalPlayBtn?.addEventListener('click', toggle);
  refs.prev?.addEventListener('click', prev);
  refs.modalPrev?.addEventListener('click', prev);
  refs.next?.addEventListener('click', next);
  refs.modalNext?.addEventListener('click', next);
  refs.shuffle?.addEventListener('click', toggleShuffle);
  refs.muteBtn?.addEventListener('click', toggleMute);
  bindQualityMenu();
  refs.fav?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!store.currentTrack) {
      showToast('先选一首歌吧');
      return;
    }
    toggleFavorite(store.currentTrack);
  });
}

function bindQualityMenu() {
  const button = document.getElementById('qualityBtn');
  const menu = document.getElementById('qualityMenu');
  if (!button || !menu) return;

  const refresh = () => {
    for (const item of menu.querySelectorAll('.quality-item')) {
      const selected = item.dataset.quality === store.quality;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-checked', String(selected));
    }
  };

  const close = () => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onEsc);
  };
  const onDocClick = (event) => {
    if (!menu.contains(event.target) && event.target !== button && !button.contains(event.target)) close();
  };
  const onEsc = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      button.focus({ preventScroll: true });
    }
  };

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    button.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) {
      refresh();
      document.addEventListener('click', onDocClick);
      document.addEventListener('keydown', onEsc);
    } else {
      close();
    }
  });
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('.quality-item');
    if (!item) return;
    event.stopPropagation();
    const nextQuality = item.dataset.quality;
    const changed = nextQuality !== store.quality;
    store.quality = nextQuality;
    saveSettings();
    refresh();
    close();
    if (changed) {
      showToast({
        standard: '已切换到标准音质，重新点歌后生效',
        exhigh: '已切换到高品 320k，重新点歌后生效',
        lossless: '已切换无损 FLAC（登录态生效，重新点歌）',
      }[nextQuality] || '音质已更新', 2600);
    }
  });
}

export function initPlayerbar() {
  bindButtons();
  setupSeeker(refs.progressTrack, refs.progressTooltip);
  setupSeeker(refs.modalProgressTrack, refs.modalTooltip);
  setupVolume();

  on('player:track', () => {
    updateTrack();
    updateState();
  });
  on('player:state', () => {
    const wasPlaying = store.status === 'playing';
    updateTrack();
    updateState();
    if (wasPlaying) maybeDockTip();
  });
  on('player:tick', updateTick);
  on('player:volume', updateVolume);
  on('player:shuffle', () => updateState());
  on('favorites:change', updateFavorite);
  on('player:error', () => updateState());

  updateTrack();
  updateState();
  updateVolume();
  updateTick({ current: 0, duration: store.currentTrack?.duration || 0 });
}
