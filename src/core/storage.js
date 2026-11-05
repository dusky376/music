export const KEYS = {
  favorites: 'pt_favorites',
  history: 'pt_history',
  settings: 'pt_settings',
  resume: 'pt_resume',
  cache: 'pt_cache_',
};

export function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存储满或被浏览器禁用时静默失败，不影响播放。
  }
}

export function readCache(name, ttl) {
  try {
    const raw = localStorage.getItem(KEYS.cache + name);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || typeof entry !== 'object' || !('data' in entry)) return null;
    if (!Number.isFinite(entry.savedAt) || Date.now() - entry.savedAt > ttl) {
      localStorage.removeItem(KEYS.cache + name);
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

export function writeCache(name, data) {
  try {
    localStorage.setItem(KEYS.cache + name, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // 缓存写入失败（配额/隐私模式）不影响功能。
  }
}

export function cleanTrack(track) {
  if (!track || typeof track !== 'object' || track.id === undefined || track.id === null) return null;
  return {
    id: String(track.id),
    name: String(track.name || '未知歌曲'),
    artist: String(track.artist || '未知歌手'),
    album: String(track.album || '未知专辑'),
    duration: Number(track.duration) || 0,
    cover: String(track.cover || '/assets/cover.svg'),
    fee: Number(track.fee) || 0,
    vip: Boolean(track.vip),
    paid: Boolean(track.paid),
    mv: Number(track.mv) || 0,
  };
}
