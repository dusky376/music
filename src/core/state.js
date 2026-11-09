import { emit } from './bus.js';
import { cleanTrack, KEYS, loadJSON, saveJSON } from './storage.js';

const storedFavorites = loadJSON(KEYS.favorites, []);
const storedHistory = loadJSON(KEYS.history, []);

export const store = {
  playlist: [],
  playQueue: [],
  currentTrack: null,
  currentIndex: -1,
  status: 'idle',
  buffering: false,
  isPlaying: false,
  volume: 0.8,
  muted: false,
  shuffle: false,
  quality: 'standard',
  filterPlayable: false,
  // 只有用户主动点过「只看可播放」才算手动设置；默认策略才能随登录态重算。
  filterManuallySet: false,
  favorites: Array.isArray(storedFavorites) ? storedFavorites.map(cleanTrack).filter(Boolean) : [],
  history: Array.isArray(storedHistory) ? storedHistory.map(cleanTrack).filter(Boolean).slice(0, 50) : [],
  lyrics: [],
  currentLyricIdx: -1,
  currentViewKey: 'top_19723756',
  activeRightTab: 'lyrics',
  unavailable: new Set(),
  queuePanelOpen: false,
  immersiveOpen: false,
  lastError: null,
};

export function isFavorited(id) {
  return store.favorites.some((track) => track.id === String(id));
}

export function toggleFavorite(track) {
  if (!track) return false;
  const id = String(track.id);
  const index = store.favorites.findIndex((item) => item.id === id);
  let added;
  if (index >= 0) {
    store.favorites.splice(index, 1);
    added = false;
  } else {
    const clean = cleanTrack(track);
    if (!clean) return false;
    store.favorites.unshift(clean);
    added = true;
  }
  saveJSON(KEYS.favorites, store.favorites);
  emit('favorites:change', { track, added, favorites: store.favorites });
  return added;
}

export function addToHistory(track) {
  if (!track) return;
  const clean = cleanTrack(track);
  if (!clean) return;
  store.history = store.history.filter((item) => item.id !== clean.id);
  store.history.unshift({ ...clean, playedAt: Date.now() });
  if (store.history.length > 50) store.history.length = 50;
  saveJSON(KEYS.history, store.history);
  emit('history:change', { history: store.history });
}

export function saveSettings() {
  saveJSON(KEYS.settings, {
    volume: store.volume,
    muted: store.muted,
    shuffle: store.shuffle,
    quality: store.quality,
    filterPlayable: store.filterPlayable,
    filterManuallySet: store.filterManuallySet,
  });
}

export function loadSettings() {
  const settings = loadJSON(KEYS.settings, {});
  if (Number.isFinite(settings.volume)) store.volume = Math.min(1, Math.max(0, settings.volume));
  store.muted = Boolean(settings.muted);
  store.shuffle = Boolean(settings.shuffle);
  if (typeof settings.quality === 'string') store.quality = settings.quality;
  if (typeof settings.filterPlayable === 'boolean') store.filterPlayable = settings.filterPlayable;
  store.filterManuallySet = Boolean(settings.filterManuallySet);
}

/**
 * 「只看可播放」是全局规则：导航的渲染、播放全部、空态起播都必须用同一份过滤结果，
 * 否则筛选开启时会播到列表里被隐藏的 VIP 歌（审查报告第 3 节 bug 9）。
 */
export function playableTracks(list) {
  const tracks = Array.isArray(list) ? list : [];
  if (!store.filterPlayable) return tracks;
  return tracks.filter(
    (track) => Boolean(track) && !track.vip && !track.paid && !store.unavailable.has(String(track.id))
  );
}
