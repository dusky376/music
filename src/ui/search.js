import { searchTracks } from '../core/api.js';
import { on } from '../core/bus.js';
import { store } from '../core/state.js';
import { clearActive, restoreCurrentView, setScrollPosition } from './nav.js';
import { renderTracklist, showEmpty, showError, showSkeleton } from './tracklist.js';
import { showToast } from './toast.js';

const input = document.getElementById('searchInput');
const capsule = document.getElementById('searchCapsule');
const clearBtn = document.getElementById('searchClearBtn');
const heroTitle = document.getElementById('heroTitle');
const heroSubtitle = document.getElementById('heroSubtitle');
const viewport = document.getElementById('viewportPanel');

let debounceTimer = 0;
let controller = null;
let requestToken = 0;
let activeQuery = '';
let composing = false;
let scrollBeforeSearch = 0;

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
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (debounceTimer) clearTimeout(debounceTimer);
      runSearch(input.value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      resetSearch();
      input.blur();
    }
  });
  clearBtn?.addEventListener('click', resetSearch);
  on('search:reset', ({ silent } = {}) => {
    abortSearch();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = 0;
    activeQuery = '';
    if (input && input.value) input.value = '';
    updateClearState();
    if (!silent) showToast('已退出搜索', 1200);
  });
  updateClearState();
}
