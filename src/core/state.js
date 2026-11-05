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
  });
}

export function loadSettings() {
  const settings = loadJSON(KEYS.settings, {});
  if (Number.isFinite(settings.volume)) store.volume = Math.min(1, Math.max(0, settings.volume));
  store.muted = Boolean(settings.muted);
  store.shuffle = Boolean(settings.shuffle);
  if (typeof settings.quality === 'string') store.quality = settings.quality;
}
