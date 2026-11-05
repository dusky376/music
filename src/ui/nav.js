import { getSection, peekSection, prefetchSection } from '../core/api.js';
import { emit, on } from '../core/bus.js';
import { playAll } from '../core/player.js';
import { store } from '../core/state.js';
import {
  renderTracklist,
  showEmpty,
  showError,
  showSkeleton,
} from './tracklist.js';
import { showToast } from './toast.js';

const viewport = document.getElementById('viewportPanel');
const heroTitle = document.getElementById('heroTitle');
const heroSubtitle = document.getElementById('heroSubtitle');
const playAllBtn = document.getElementById('playAllBtn');
const sidebar = document.getElementById('sidebarPanel');
const mobileMenuBtn = document.getElementById('mobileMenuBtn');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
const navLinks = [...document.querySelectorAll('.nav-link[data-key]')];

const scrollPositions = new Map();
let lastNavKey = store.currentViewKey || 'top_19723756';
let controller = null;
let requestToken = 0;

function navFor(key) {
  return navLinks.find((link) => link.dataset.key === key) || null;
}

function setActive(key) {
  for (const link of navLinks) {
    const active = link.dataset.key === key;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function setTitle(title, subtitle) {
  if (heroTitle) heroTitle.textContent = title;
  if (heroSubtitle) heroSubtitle.textContent = subtitle || '';
}

function cacheScroll() {
  if (viewport) scrollPositions.set(lastNavKey, viewport.scrollTop);
}

function restoreScroll(key) {
  if (!viewport) return;
  requestAnimationFrame(() => {
    viewport.scrollTop = scrollPositions.get(key) || 0;
  });
}

function renderLocal(key, link) {
  const isFavorites = key === 'local___favorites';
  const source = isFavorites ? store.favorites : store.history;
  store.playlist = source.slice();
  const title = link?.dataset.title || (isFavorites ? '我喜欢的音乐' : '最近播放');
  const subtitle = source.length
    ? `${source.length} 首 · ${link?.dataset.sub || ''}`
    : link?.dataset.sub || '';
  setTitle(title, subtitle);
  if (!source.length) {
    showEmpty(
      isFavorites ? '还没有喜欢的歌曲' : '还没有播放记录',
      isFavorites ? '在列表里点一下爱心，歌就会留在这里。' : '播放过的歌曲会自动出现在这里。'
    );
  } else {
    renderTracklist(source);
  }
  restoreScroll(key);
}

function renderData(data, { preserveScroll = false } = {}) {
  store.playlist = Array.isArray(data.tracks) ? data.tracks : [];
  setTitle(data.title || '音乐', data.subtitle || '');
  if (!store.playlist.length) {
    showEmpty('这个板块暂时没有歌曲', '换一个板块，或者稍后再试。', {
      label: '重新加载',
      onClick: () => loadView(store.currentViewKey, { force: true, skeleton: true }),
    });
  } else {
    renderTracklist(store.playlist);
  }
  if (preserveScroll) restoreScroll(store.currentViewKey);
}

async function fetchSection(key, { force = false } = {}) {
  const currentToken = ++requestToken;
  controller?.abort();
  controller = new AbortController();
  const link = navFor(key);
  const cached = peekSection(key);
  const showSkeletonFirst = !cached;
  if (showSkeletonFirst) showSkeleton();
  else renderData(cached.data, { preserveScroll: true });

  if (cached && Date.now() - cached.savedAt < 2 * 60 * 1000 && !force) {
    return;
  }

  try {
    const data = await getSection(key, { signal: controller.signal, force: true });
    if (currentToken !== requestToken || store.currentViewKey !== key) return;
    renderData(data, { preserveScroll: true });
    if (data.stale) showToast('网络波动，正在显示上次缓存的内容', 2600);
    if (link) setActive(key);
  } catch (error) {
    if (currentToken !== requestToken || error?.code === 'ABORTED') return;
    if (store.currentViewKey !== key) return;
    if (!cached) {
      showError(error.message || '加载失败', () => loadView(key, { force: true, skeleton: true }));
    } else {
      showToast('刷新失败，继续显示缓存内容', 2600);
    }
  }
}

export function loadView(key, { force = false, skeleton = false } = {}) {
  const link = navFor(key);
  if (!link) return;
  const previousKey = store.currentViewKey;
  if (previousKey) {
    scrollPositions.set(previousKey, viewport?.scrollTop || 0);
  }
  lastNavKey = key;
  store.currentViewKey = key;
  setActive(key);
  closeSidebar();
  controller?.abort();
  requestToken += 1;
  emit('search:reset', { silent: true });

  if (key.startsWith('local_')) {
    renderLocal(key, link);
    return;
  }

  if (link.dataset.title) setTitle(link.dataset.title, link.dataset.sub || '');
  if (skeleton) showSkeleton();
  fetchSection(key, { force });
}

function isMobileLayout() {
  return window.matchMedia('(max-width: 900px)').matches;
}

export function closeSidebar() {
  document.body.classList.remove('sidebar-open');
  mobileMenuBtn?.setAttribute('aria-expanded', 'false');
  sidebarBackdrop?.classList.remove('active');
  if (isMobileLayout()) sidebar?.setAttribute('aria-hidden', 'true');
  else sidebar?.removeAttribute('aria-hidden');
}

function openSidebar() {
  document.body.classList.add('sidebar-open');
  mobileMenuBtn?.setAttribute('aria-expanded', 'true');
  sidebar?.setAttribute('aria-hidden', 'false');
  sidebarBackdrop?.classList.add('active');
  navLinks.find((link) => link.classList.contains('active'))?.focus({ preventScroll: true });
}

export function toggleSidebar() {
  if (document.body.classList.contains('sidebar-open')) closeSidebar();
  else openSidebar();
}

export function clearActive() {
  for (const link of navLinks) {
    link.classList.remove('active');
    link.removeAttribute('aria-current');
  }
}

export function restoreCurrentView() {
  const link = navFor(lastNavKey) || navLinks[0];
  if (link) loadView(link.dataset.key);
}

export function setScrollPosition(key, top) {
  if (!key) return;
  scrollPositions.set(key, Math.max(0, Number(top) || 0));
}

function handleNavClick(event) {
  const link = event.currentTarget;
  loadView(link.dataset.key);
}

function handleNavKey(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  loadView(event.currentTarget.dataset.key);
}

function refreshLocalView() {
  if (store.currentViewKey === 'local___favorites' || store.currentViewKey === 'local___history') {
    renderLocal(store.currentViewKey, navFor(store.currentViewKey));
  }
}

function schedulePrefetch() {
  if (store.currentViewKey !== 'top_19723756') return;
  const run = window.requestIdleCallback || ((callback) => setTimeout(callback, 1500));
  run(() => prefetchSection('top_3778678'), { timeout: 5000 });
}

export function initNav() {
  navLinks.forEach((link) => {
    link.tabIndex = 0;
    link.addEventListener('click', handleNavClick);
    link.addEventListener('keydown', handleNavKey);
  });
  mobileMenuBtn?.addEventListener('click', toggleSidebar);
  sidebarBackdrop?.addEventListener('click', closeSidebar);

  playAllBtn?.addEventListener('click', () => {
    if (!store.playlist.length) {
      showToast('当前列表没有可播放的歌曲', 1800);
      return;
    }
    playAll(store.playlist);
  });

  on('favorites:change', refreshLocalView);
  on('history:change', refreshLocalView);

  const initial = navFor(store.currentViewKey) || navLinks[0];
  if (initial) loadView(initial.dataset.key);
  setTimeout(schedulePrefetch, 3500);
}
