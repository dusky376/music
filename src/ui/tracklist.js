import { on } from '../core/bus.js';
import { formatTime } from '../core/format.js';
import { playFromList } from '../core/player.js';
import { isFavorited, store, toggleFavorite } from '../core/state.js';

const FALLBACK_COVER = '/assets/cover.svg';
const body = document.getElementById('trackGridBody');
let tracks = [];
let retryHandler = null;

function makeElement(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function playIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('stroke', 'none');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M8 5v14l11-7z');
  svg.appendChild(path);
  return svg;
}

function heartIcon(filled) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  if (filled) {
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('stroke', 'none');
  }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z');
  svg.appendChild(path);
  return svg;
}

function createRow(track, index) {
  const row = makeElement('div', 'track-item');
  row.dataset.trackId = track.id;
  row.dataset.index = String(index);
  row.setAttribute('role', 'row');
  row.tabIndex = 0;

  const indexCell = makeElement('div', 'col-index');
  indexCell.setAttribute('role', 'cell');
  indexCell.appendChild(makeElement('span', 'idx-text', String(index + 1)));
  const hover = makeElement('span', 'hover-play-icon');
  hover.appendChild(playIcon());
  indexCell.appendChild(hover);
  const bars = makeElement('span', 'sound-bars');
  bars.appendChild(document.createElement('span'));
  bars.appendChild(document.createElement('span'));
  bars.appendChild(document.createElement('span'));
  indexCell.appendChild(bars);

  const art = document.createElement('img');
  art.className = 'col-art';
  art.src = track.cover || FALLBACK_COVER;
  art.alt = '';
  art.width = 42;
  art.height = 42;
  art.decoding = 'async';
  art.loading = index < 12 ? 'eager' : 'lazy';
  if (index < 6) art.setAttribute('fetchpriority', 'high');
  art.addEventListener('error', () => {
    if (art.src.endsWith(FALLBACK_COVER)) return;
    art.src = FALLBACK_COVER;
  });

  const name = makeElement('div', 'col-name');
  name.setAttribute('role', 'cell');
  name.appendChild(makeElement('span', 'track-name-text', track.name));
  if (track.vip) name.appendChild(makeElement('span', 'badge badge-vip', 'VIP'));
  else if (track.paid) name.appendChild(makeElement('span', 'badge', '付费'));

  const artist = makeElement('div', 'col-artist', track.artist);
  artist.setAttribute('role', 'cell');
  const album = makeElement('div', 'col-album', track.album);
  album.setAttribute('role', 'cell');
  const duration = makeElement('div', 'col-duration', formatTime(track.duration));
  duration.setAttribute('role', 'cell');

  const fav = makeElement('button', 'track-fav-btn');
  fav.type = 'button';
  fav.title = isFavorited(track.id) ? '取消喜欢' : '喜欢';
  fav.setAttribute('aria-label', fav.title);
  if (isFavorited(track.id)) {
    fav.classList.add('favorited');
    fav.appendChild(heartIcon(true));
  } else {
    fav.appendChild(heartIcon(false));
  }

  row.append(indexCell, art, name, artist, album, duration, fav);
  if (store.currentTrack?.id === track.id) {
    row.classList.add('active');
    if (!store.isPlaying) bars.classList.add('paused');
    row.setAttribute('aria-current', 'true');
  }
  if (store.unavailable.has(track.id)) row.classList.add('unavailable');
  return row;
}

function setStateMessage(icon, title, detail, action) {
  body.replaceChildren();
  const box = makeElement('div', 'state-box');
  box.appendChild(makeElement('div', 'state-icon', icon));
  box.appendChild(makeElement('h3', 'state-title', title));
  if (detail) box.appendChild(makeElement('p', 'state-detail', detail));
  if (action) {
    const button = makeElement('button', 'state-action', action.label);
    button.type = 'button';
    button.addEventListener('click', action.onClick);
    box.appendChild(button);
  }
  body.appendChild(box);
}

export function showSkeleton(count = 8) {
  body.replaceChildren();
  const wrap = makeElement('div', 'skeleton-wrap');
  wrap.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < count; i += 1) wrap.appendChild(makeElement('div', 'skeleton-row'));
  body.appendChild(wrap);
  body.setAttribute('aria-busy', 'true');
}

export function renderTracklist(nextTracks) {
  tracks = Array.isArray(nextTracks) ? nextTracks.slice() : [];
  retryHandler = null;
  body.removeAttribute('aria-busy');
  if (!tracks.length) {
    setStateMessage('♪', '这里暂时没有歌曲', '换一个板块，或者清除搜索后再试。');
    return;
  }
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < tracks.length; i += 1) fragment.appendChild(createRow(tracks[i], i));
  body.replaceChildren(fragment);
}

export function showEmpty(title, detail, action) {
  tracks = [];
  setStateMessage('♪', title, detail, action);
}

export function showError(message, onRetry) {
  tracks = [];
  retryHandler = onRetry;
  setStateMessage(
    '!',
    '这次没有加载出来',
    message || '网络可能开了个小差，再试一次吧。',
    onRetry
      ? {
          label: '重新加载',
          onClick: () => {
            const handler = retryHandler;
            retryHandler = null;
            handler?.();
          },
        }
      : null
  );
}

export function refreshActive() {
  const activeId = store.currentTrack?.id ? String(store.currentTrack.id) : '';
  for (const row of body.querySelectorAll('.track-item')) {
    const isActive = Boolean(activeId) && row.dataset.trackId === activeId;
    row.classList.toggle('active', isActive);
    row.classList.toggle('unavailable', store.unavailable.has(row.dataset.trackId));
    row.toggleAttribute('aria-current', isActive);
    row.querySelector('.sound-bars')?.classList.toggle('paused', !store.isPlaying);
  }
}

function refreshFavorites() {
  for (const row of body.querySelectorAll('.track-item')) {
    const button = row.querySelector('.track-fav-btn');
    if (!button) continue;
    const favored = isFavorited(row.dataset.trackId);
    button.classList.toggle('favorited', favored);
    button.title = favored ? '取消喜欢' : '喜欢';
    button.setAttribute('aria-label', button.title);
    button.replaceChildren(heartIcon(favored));
  }
}

function handleClick(event) {
  const row = event.target.closest('.track-item');
  if (!row || !body.contains(row)) return;
  const index = Number(row.dataset.index);
  const track = tracks[index];
  if (!track) return;
  const fav = event.target.closest('.track-fav-btn');
  if (fav) {
    event.stopPropagation();
    toggleFavorite(track);
    return;
  }
  playFromList(tracks, index);
}

function handleKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest('.track-item');
  if (!row) return;
  event.preventDefault();
  event.stopPropagation();
  const index = Number(row.dataset.index);
  if (tracks[index]) playFromList(tracks, index);
}

export function initTracklist() {
  body.addEventListener('click', handleClick);
  body.addEventListener('keydown', handleKeydown);
  on('player:track', refreshActive);
  on('player:state', refreshActive);
  on('player:error', refreshActive);
  on('favorites:change', refreshFavorites);
}
