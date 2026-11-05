import { on } from '../core/bus.js';
import { formatTime } from '../core/format.js';
import { playAt, removeAt } from '../core/player.js';
import { store } from '../core/state.js';

const panel = document.getElementById('queuePanel');
const list = document.getElementById('queueList');
const closeBtn = document.getElementById('queueCloseBtn');
const openBtn = document.getElementById('queueBtn');
const backdrop = document.getElementById('queueBackdrop');
const FALLBACK = '/assets/cover.svg';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createItem(track, index) {
  const item = el('div', 'queue-item');
  item.dataset.index = String(index);
  item.dataset.trackId = track.id;
  item.tabIndex = 0;

  const art = document.createElement('img');
  art.className = 'queue-item-art';
  art.src = track.cover || FALLBACK;
  art.alt = '';
  art.width = 40;
  art.height = 40;
  art.loading = 'lazy';
  art.decoding = 'async';
  art.addEventListener('error', () => {
    if (!art.src.endsWith(FALLBACK)) art.src = FALLBACK;
  });

  const meta = el('div', 'queue-item-meta');
  meta.appendChild(el('div', 'queue-item-name', track.name));
  meta.appendChild(el('div', 'queue-item-artist', track.artist));

  const remove = el('button', 'queue-item-remove', '×');
  remove.type = 'button';
  remove.title = '从队列移除';
  remove.setAttribute('aria-label', `从队列移除 ${track.name}`);
  remove.dataset.remove = String(index);

  item.append(art, meta, el('span', 'queue-item-dur', formatTime(track.duration)));
  if (index !== store.currentIndex) item.appendChild(remove);

  if (index === store.currentIndex) {
    item.classList.add('active');
    item.setAttribute('aria-current', 'true');
  }
  return item;
}

export function renderQueue() {
  if (!list) return;
  list.replaceChildren();
  if (!store.playQueue.length) {
    const empty = el('div', 'queue-empty');
    empty.appendChild(el('div', 'queue-empty-icon', '♫'));
    empty.appendChild(el('p', '', '队列还是空的'));
    empty.appendChild(el('span', '', '从榜单里点一首歌开始'));
    list.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (let i = 0; i < store.playQueue.length; i += 1) {
    fragment.appendChild(createItem(store.playQueue[i], i));
  }
  list.appendChild(fragment);
}

function refreshActive() {
  let active = null;
  for (const item of list.querySelectorAll('.queue-item')) {
    const isActive = Number(item.dataset.index) === store.currentIndex;
    item.classList.toggle('active', isActive);
    item.toggleAttribute('aria-current', isActive);
    const remove = item.querySelector('.queue-item-remove');
    if (remove) remove.hidden = isActive;
    if (isActive) active = item;
  }
  return active;
}

function scrollToActive() {
  const active = refreshActive();
  active?.scrollIntoView({ block: 'nearest' });
}

export function openQueue() {
  if (!panel) return;
  if (store.immersiveOpen) return;
  store.queuePanelOpen = true;
  panel.classList.add('active');
  panel.setAttribute('aria-hidden', 'false');
  backdrop?.classList.add('active');
  openBtn?.classList.add('active');
  openBtn?.setAttribute('aria-expanded', 'true');
  scrollToActive();
}

export function closeQueue() {
  if (!panel) return;
  store.queuePanelOpen = false;
  panel.classList.remove('active');
  panel.setAttribute('aria-hidden', 'true');
  backdrop?.classList.remove('active');
  openBtn?.classList.remove('active');
  openBtn?.setAttribute('aria-expanded', 'false');
}

export function toggleQueue() {
  if (store.queuePanelOpen) closeQueue();
  else openQueue();
}

function handleListClick(event) {
  const remove = event.target.closest('[data-remove]');
  if (remove) {
    event.stopPropagation();
    removeAt(Number(remove.dataset.remove));
    return;
  }
  const item = event.target.closest('.queue-item');
  if (!item) return;
  const index = Number(item.dataset.index);
  if (store.playQueue[index]) playAt(index);
}

function handleListKey(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const item = event.target.closest('.queue-item');
  if (!item) return;
  event.preventDefault();
  event.stopPropagation();
  const index = Number(item.dataset.index);
  if (store.playQueue[index]) playAt(index);
}

export function initQueue() {
  openBtn?.addEventListener('click', toggleQueue);
  closeBtn?.addEventListener('click', closeQueue);
  backdrop?.addEventListener('click', closeQueue);
  list?.addEventListener('click', handleListClick);
  list?.addEventListener('keydown', handleListKey);
  on('player:queue', () => {
    renderQueue();
    if (store.queuePanelOpen) scrollToActive();
  });
  on('player:track', () => {
    refreshActive();
  });
  on('player:state', refreshActive);
  renderQueue();
}
