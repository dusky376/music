import { searchTracks } from '../core/api.js';
import { on } from '../core/bus.js';
import { loadJSON, saveJSON } from '../core/storage.js';
import { store } from '../core/state.js';
import { clearActive, restoreCurrentView, setScrollPosition } from './nav.js';
import { renderTracklist, showEmpty, showError, showSkeleton } from './tracklist.js';
import { showToast } from './toast.js';

const input = document.getElementById('searchInput');
const capsule = document.getElementById('searchCapsule');
const clearBtn = document.getElementById('searchClearBtn');
const historyPanel = document.getElementById('searchHistoryPanel');
const heroTitle = document.getElementById('heroTitle');
const heroSubtitle = document.getElementById('heroSubtitle');
const viewport = document.getElementById('viewportPanel');

const HISTORY_KEY = 'pt_search_history';
const HISTORY_MAX = 10;

let debounceTimer = 0;
let controller = null;
let requestToken = 0;
let activeQuery = '';
let composing = false;
let scrollBeforeSearch = 0;

const savedHistory = loadJSON(HISTORY_KEY, []);
let historyList = Array.isArray(savedHistory)
  ? savedHistory.filter((k) => typeof k === 'string' && k.trim()).slice(0, HISTORY_MAX)
  : [];

function saveHistory() {
  saveJSON(HISTORY_KEY, historyList);
}

/** 写入搜索历史：去重后置顶，上限 HISTORY_MAX 条。 */
function pushHistory(keyword) {
  const value = String(keyword || '').trim();
  if (!value) return;
  historyList = [value, ...historyList.filter((item) => item !== value)].slice(0, HISTORY_MAX);
  saveHistory();
}

function removeHistory(keyword) {
  historyList = historyList.filter((item) => item !== keyword);
  saveHistory();
  renderHistory();
}

function clearAllHistory() {
  historyList = [];
  saveHistory();
  hideHistoryPanel();
}

function renderHistory() {
  if (!historyPanel) return;
  historyPanel.replaceChildren();
  if (!historyList.length) {
    hideHistoryPanel();
    return;
  }
  const header = document.createElement('div');
  header.className = 'search-history-head';
  const title = document.createElement('span');
  title.textContent = '搜索历史';
  const clearAll = document.createElement('button');
  clearAll.type = 'button';
  clearAll.className = 'search-history-clear';
  clearAll.textContent = '清空';
  clearAll.addEventListener('click', clearAllHistory);
  header.append(title, clearAll);
  historyPanel.appendChild(header);

  for (const keyword of historyList) {
    const row = document.createElement('div');
    row.className = 'search-history-item';
    row.setAttribute('role', 'option');
    row.tabIndex = 0;
    const text = document.createElement('span');
    text.className = 'search-history-text';
    text.textContent = keyword;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'search-history-remove';
    remove.setAttribute('aria-label', `删除搜索历史：${keyword}`);
    remove.textContent = '✕';
    // mousedown 先于 blur，避免点击历史项时面板先失焦消失。
    row.addEventListener('mousedown', (event) => event.preventDefault());
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      if (event.target === remove) return;
      hideHistoryPanel();
      if (input) input.value = keyword;
      runSearch(keyword);
    });
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      removeHistory(keyword);
    });
    row.append(text, remove);
    historyPanel.appendChild(row);
  }
}

function showHistoryPanel() {
  if (!historyPanel || !historyList.length) return;
  renderHistory();
  historyPanel.hidden = false;
  input?.setAttribute('aria-expanded', 'true');
}

function hideHistoryPanel() {
  if (!historyPanel) return;
  historyPanel.hidden = true;
  input?.setAttribute('aria-expanded', 'false');
}

function maybeToggleHistoryPanel() {
  const keyword = input?.value.trim() || '';
  if (!input || keyword) {
    hideHistoryPanel();
    return;
  }
  showHistoryPanel();
}

function updateClearState() {
  capsule?.classList.toggle('has-content', Boolean(input?.value.trim()));
}

function abortSearch() {
  controller?.abort();
  controller = null;
  requestToken += 1;
}

function setHeader(query) {
  if (heroTitle) heroTitle.textContent = '搜索结果';
  if (heroSubtitle) heroSubtitle.textContent = `“${query}” · 歌曲 / 歌手 / 专辑`;
}

async function runSearch(query) {
  const keyword = String(query || '').trim();
  abortSearch();
  if (!keyword) {
    resetSearch();
    return;
  }
  if (!activeQuery) scrollBeforeSearch = viewport?.scrollTop || 0;
  activeQuery = keyword;
  const token = requestToken;
  controller = new AbortController();
  clearActive();
  setHeader(keyword);
  showSkeleton();
  viewport?.scrollTo({ top: 0 });
  document.getElementById('trackGridBody')?.setAttribute('aria-busy', 'true');

  try {
    const data = await searchTracks(keyword, { signal: controller.signal });
    if (token !== requestToken) return;
    const tracks = data.tracks || [];
    store.playlist = tracks;
    if (!tracks.length) {
      showEmpty('没有找到相关歌曲', '试试更短的关键词、歌手名，或者检查有没有错别字。', {
        label: '换个关键词',
        onClick: () => {
          input?.focus();
          input?.select();
        },
      });
    } else {
      renderTracklist(tracks);
    }
  } catch (error) {
    if (token !== requestToken || error?.code === 'ABORTED') return;
    showError(error.message || '搜索失败', () => runSearch(keyword));
  }
}

function scheduleSearch() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runSearch(input?.value || ''), 280);
}

function resetSearch() {
  abortSearch();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = 0;
  activeQuery = '';
  if (input) input.value = '';
  updateClearState();
  hideHistoryPanel();
  restoreCurrentView();
  setScrollPosition(store.currentViewKey, scrollBeforeSearch);
}

function onInput() {
  updateClearState();
  const keyword = input?.value.trim() || '';
  if (!keyword) {
    resetSearch();
    return;
  }
  scheduleSearch();
}

export function initSearch() {
  input?.addEventListener('compositionstart', () => {
    composing = true;
  });
  input?.addEventListener('compositionend', () => {
    composing = false;
    updateClearState();
    scheduleSearch();
  });
  input?.addEventListener('input', () => {
    if (composing) return;
    onInput();
  });
  input?.addEventListener('focus', maybeToggleHistoryPanel);
  // blur 延迟：给 click 历史项留出触发窗口（历史项已用 mousedown 防抖动）。
  input?.addEventListener('blur', () => setTimeout(hideHistoryPanel, 120));
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (debounceTimer) clearTimeout(debounceTimer);
      const keyword = input.value.trim();
      // 只有回车主动搜索才写历史；防抖的边输边搜不写。
      pushHistory(keyword);
      runSearch(input.value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      resetSearch();
      input.blur();
    }
  });
  clearBtn?.addEventListener('click', resetSearch);
  // 点击面板外关闭
  document.addEventListener('click', (event) => {
    if (historyPanel?.hidden) return;
    if (capsule?.contains(event.target)) return;
    hideHistoryPanel();
  });
  on('search:reset', ({ silent } = {}) => {
    abortSearch();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = 0;
    activeQuery = '';
    if (input && input.value) input.value = '';
    updateClearState();
    hideHistoryPanel();
    if (!silent) showToast('已退出搜索', 1200);
  });
  updateClearState();
}
