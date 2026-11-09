import { getSection, peekSection, prefetchSection, getLoginStatusOnce } from '../core/api.js';
import { emit, on } from '../core/bus.js';
import { playAll } from '../core/player.js';
import { playableTracks, saveSettings, store } from '../core/state.js';
import { isLogged } from './login.js';
import { isSearchActive, rerenderSearch } from './search.js';
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
const playableFilterBtn = document.getElementById('playableFilterBtn');

const scrollPositions = new Map();
let lastNavKey = store.currentViewKey || 'top_19723756';
let controller = null;
let requestToken = 0;

/** 与 core/state.js 的 playableTracks 保持同一套规则，避免 UI 与播放器各筛各的。 */
function playableList(list) {
  return playableTracks(list);
}

function isPlayable(track) {
  return Boolean(track) && !track.vip && !track.paid && !store.unavailable.has(String(track.id));
}

function hasPlayableHint(list) {
  // 列表里有真实可播的歌时才显示筛选开关，避免空板块上出现无意义按钮。
  return list.some(isPlayable);
}

let filterAutoTuned = false;

/** 用独立标记判断「用户是否手动设置过筛选」。
 * 不能用 pt_settings.filterPlayable 是否存在来推断：saveSettings() 是整体写入，
 * 拖音量/静音/随机都会顺带把这个字段写进去。 */
function hasManualFilterSetting() {
  if (store.filterManuallySet) return true;
  try {
    return localStorage.getItem('pt_filter_manual') === '1';
  } catch {
    return false;
  }
}

/** 按登录态重算默认筛选。返回本次是否真的改动了值，供调用方决定要不要刷新视图。 */
function applyFilterDefault(serverLogged) {
  const before = store.filterPlayable;
  if (hasManualFilterSetting()) {
    syncFilterButton();
    return false;
  }
  // 服务端登录态优先；拿不到时退回本地 isLogged()，随后 login:changed 会纠正。
  const logged = typeof serverLogged === 'boolean' ? serverLogged : isLogged();
  store.filterPlayable = !logged;
  // 自动决定不写盘：让 pt_settings.filterPlayable 只代表「用户手动设置过」。
  syncFilterButton();
  return store.filterPlayable !== before;
}

function refreshCurrentView() {
  // 搜索结果页只重渲染结果、保留关键词与输入框；其它视图走原来的刷新。
  if (isSearchActive()) rerenderSearch();
  else loadView(store.currentViewKey, { force: false });
}

/** 用户没手动设置过筛选时，按服务端登录态给默认值：
 * 未登录默认「只看可播放」，登录后默认全显。异步等状态，避免先用本地缓存算错。 */
async function initFilterDefault() {
  if (filterAutoTuned) return;
  filterAutoTuned = true;
  let info = null;
  try {
    info = await Promise.race([
      getLoginStatusOnce(),
      new Promise((resolve) => setTimeout(() => resolve(null), 1200)),
    ]);
  } catch {
    info = null;
  }
  if (applyFilterDefault(info?.logged)) refreshCurrentView();
}

function onLoginChanged({ logged } = {}) {
  // 服务端登录态变化时，仅在用户没手动设置过时重算一次默认值。
  if (applyFilterDefault(logged)) refreshCurrentView();
}

function syncFilterButton(totalList) {
  if (playableFilterBtn) {
    playableFilterBtn.setAttribute('aria-pressed', String(store.filterPlayable));
    playableFilterBtn.classList.toggle('active', store.filterPlayable);
  }
}

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
  const visibleList = playableList(source);
  const subtitle = visibleList.length
    ? `${visibleList.length} 首 · ${link?.dataset.sub || ''}`
    : link?.dataset.sub || '';
  setTitle(title, subtitle);
  syncFilterButton();
  if (!visibleList.length) {
    showEmpty(
      isFavorites ? '还没有喜欢的歌曲' : '还没有播放记录',
      store.filterPlayable && source.length
        ? '筛选只看可播放后，列表里暂时没有符合的歌曲，可以关掉筛选看看全部。'
        : isFavorites
          ? '在列表里点一下爱心，歌就会留在这里。'
          : '播放过的歌曲会自动出现在这里。'
    );
  } else {
    renderTracklist(visibleList);
  }
  restoreScroll(key);
}

function renderData(data, { preserveScroll = false } = {}) {
  store.playlist = Array.isArray(data.tracks) ? data.tracks : [];
  const visibleList = playableList(store.playlist);
  setTitle(
    data.title || '音乐',
    visibleList.length && visibleList.length !== store.playlist.length
      ? `${data.subtitle || ''}（可播放 ${visibleList.length}/${store.playlist.length}）`
      : data.subtitle || ''
  );
  if (!store.playlist.length) {
    showEmpty('这个板块暂时没有歌曲', '换一个板块，或者稍后再试。', {
      label: '重新加载',
      onClick: () => loadView(store.currentViewKey, { force: true, skeleton: true }),
    });
  } else if (!visibleList.length) {
    showEmpty(
      '这个板块都是 VIP / 付费歌曲',
      '当前登录态下没有可直接播放的曲目，可以关掉"只看可播放"再选。',
      { label: '关闭筛选', onClick: togglePlayableFilter }
    );
  } else {
    renderTracklist(visibleList);
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

function togglePlayableFilter() {
  store.filterPlayable = !store.filterPlayable;
  // 用户主动操作后，默认筛选策略不再随登录态覆盖他的选择。
  store.filterManuallySet = true;
  try {
    localStorage.setItem('pt_filter_manual', '1');
  } catch {
    // 隐私模式下 storage 不可用，store 里的标记本次会话仍有效。
  }
  saveSettings();
  syncFilterButton();
  showToast(store.filterPlayable ? '已开启"只看可播放"' : '已显示全部歌曲', 1800);
  // 搜索结果页切筛选不回原板块，只重渲染结果并保留关键词与输入框。
  refreshCurrentView();
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
  playableFilterBtn?.addEventListener('click', togglePlayableFilter);
  initFilterDefault();
  navLinks.forEach((link) => {
    link.tabIndex = 0;
    link.addEventListener('click', handleNavClick);
    link.addEventListener('keydown', handleNavKey);
  });
  mobileMenuBtn?.addEventListener('click', toggleSidebar);
  sidebarBackdrop?.addEventListener('click', closeSidebar);

  playAllBtn?.addEventListener('click', () => {
    // 「播放全部」尊重「只看可播放」：用过滤后的列表，避免连播被隐藏的 VIP 歌。
    const list = playableList(store.playlist);
    if (!list.length) {
      showToast(
        store.filterPlayable
          ? '筛选后没有可播放的歌曲，可关闭「只看可播放」再试'
          : '当前列表没有可播放的歌曲',
        1800
      );
      return;
    }
    playAll(list);
  });

  on('favorites:change', refreshLocalView);
  on('history:change', refreshLocalView);
  on('login:changed', onLoginChanged);

  const initial = navFor(store.currentViewKey) || navLinks[0];
  if (initial) loadView(initial.dataset.key);
  setTimeout(schedulePrefetch, 3500);
}
