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
import { isFavorited, store, toggleFavorite } from '../core/state.js';
import { showToast } from './toast.js';

const FALLBACK = '/assets/cover.svg';
const PLAY_PATH = '<path d="M8 5v14l11-7z"/>';
const PAUSE_PATH = '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>';

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
  playIcon: document.getElementById('playIconSvg'),
  modalPlayBtn: document.getElementById('modalPlayBtn'),
  modalPlayIcon: document.getElementById('modalPlaySvg'),
  shuffle: document.getElementById('shuffleBtn'),
  prev: document.getElementById('prevBtn'),
  next: document.getElementById('nextBtn'),
  modalPrev: document.getElementById('modalPrevBtn'),
  modalNext: document.getElementById('modalNextBtn'),
  curr: document.getElementById('currTime'),
  dur: document.getElementById('durTime'),
  modalCurr: document.getElementById('modalCurrTime'),
  modalDur: document.getElementById('modalDurTime'),
  progressBar: document.getElementById('progressBar'),
  modalProgressBar: document.getElementById('modalProgressBar'),
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

function setCover(img, src) {
  if (!img) return;
  const nextSrc = src || FALLBACK;
  if (img.getAttribute('src') === nextSrc) return;
  img.src = nextSrc;
  img.onerror = () => {
    img.onerror = null;
    img.src = FALLBACK;
  };
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

function setIcon(svg, playing) {
  if (svg) svg.innerHTML = playing ? PAUSE_PATH : PLAY_PATH;
}

function updateState() {
  const playing = store.status === 'playing';
  const loading = store.status === 'loading' || store.buffering;
  setIcon(refs.playIcon, playing);
  setIcon(refs.modalPlayIcon, playing);
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
  const percent = `${clamp(ratio, 0, 1) * 100}%`;
  if (refs.progressBar) refs.progressBar.style.width = percent;
  if (refs.modalProgressBar) refs.modalProgressBar.style.width = percent;
  if (refs.progressTrack) refs.progressTrack.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  if (refs.modalProgressTrack) refs.modalProgressTrack.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  if (refs.curr) refs.curr.textContent = formatTime(safeCurrent);
  if (refs.modalCurr) refs.modalCurr.textContent = formatTime(safeCurrent);
  if (refs.dur) refs.dur.textContent = formatTime(safeDuration);
  if (refs.modalDur) refs.modalDur.textContent = formatTime(safeDuration);
}

function updateVolume({ volume = store.volume, muted = store.muted } = {}) {
  const value = muted ? 0 : volume;
  if (refs.volumeBar) refs.volumeBar.style.width = `${clamp(value, 0, 1) * 100}%`;
  refs.volumeTrack?.setAttribute('aria-valuenow', String(Math.round(clamp(value, 0, 1) * 100)));
  if (refs.muteBtn) {
    refs.muteBtn.classList.toggle('active', muted);
    refs.muteBtn.setAttribute('aria-pressed', String(muted));
    refs.muteBtn.setAttribute('title', muted ? '取消静音' : '静音');
  }
}

function setupSeeker(track, bar, tooltip) {
  if (!track || !bar) return;
  let pointerId = null;

  const ratioAt = (clientX) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return 0;
    return clamp((clientX - rect.left) / rect.width, 0, 1);
  };

  const preview = (ratio, clientX) => {
    draggingSeeker = true;
    bar.style.width = `${ratio * 100}%`;
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
  refs.fav?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!store.currentTrack) {
      showToast('先选一首歌吧');
      return;
    }
    toggleFavorite(store.currentTrack);
  });
}

export function initPlayerbar() {
  bindButtons();
  setupSeeker(refs.progressTrack, refs.progressBar, refs.progressTooltip);
  setupSeeker(refs.modalProgressTrack, refs.modalProgressBar, refs.modalTooltip);
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
