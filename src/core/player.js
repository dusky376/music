import { getTrackUrl } from './api.js';
import { emit } from './bus.js';
import { addToHistory, playableTracks, saveSettings, store } from './state.js';
import { cleanTrack, KEYS, loadJSON, saveJSON } from './storage.js';

const audio = document.getElementById('audioElement');
const RESUME_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const MAX_AUTO_FAILURES = 3;

let token = 0;
let urlController = null;
let loadedUrl = '';
let tickRaf = 0;
let lastTickAt = 0;
let lastSaveAt = 0;
let lastPositionAt = 0;
let pendingSeek = null;
let restorePosition = 0;
let mediaRetry = 0;
let autoMode = false;
let failureTimer = 0;
let historyAdded = false;
let initialized = false;

function formatMediaError() {
  const code = audio.error?.code;
  if (code === 1) return '播放被中止，请重试';
  if (code === 2) return '网络中断，音频没有加载完整';
  if (code === 3) return '音频解码失败，换一首试试';
  if (code === 4) return '该歌曲当前无法播放';
  return '音频加载失败';
}

function setStatus(status) {
  store.status = status;
  if (status !== 'playing') {
    store.isPlaying = status === 'buffering' && !audio.paused;
  }
  emit('player:state', {
    status: store.status,
    isPlaying: store.isPlaying,
    buffering: store.buffering,
    track: store.currentTrack,
  });
}

function toast(message, duration = 2800, tone = 'default') {
  emit('toast', { message, duration, tone });
}

function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  try {
    const artworkUrl = new URL(track.cover || '/assets/cover.svg', location.href).href;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.name,
      artist: track.artist,
      album: track.album,
      artwork: [
        { src: artworkUrl, sizes: '300x300', type: 'image/jpeg' },
        { src: artworkUrl, sizes: '96x96', type: 'image/jpeg' },
      ],
    });
  } catch {
    // 某些浏览器不支持 MediaMetadata，忽略即可。
  }
}

function updatePositionState(force = false) {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const now = performance.now();
  if (!force && now - lastPositionAt < 900) return;
  const duration = Number(audio.duration);
  const position = Number(audio.currentTime);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;
  lastPositionAt = now;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(duration, Math.max(0, position)),
    });
  } catch {
    // 某些状态下 duration/position 尚不可用，下一帧再试。
  }
}

function emitTick() {
  emit('player:tick', {
    current: Number(audio.currentTime) || 0,
    duration: Number(audio.duration) || store.currentTrack?.duration || 0,
    paused: audio.paused,
  });
}

function tick(now = performance.now()) {
  if (!tickRaf) return;
  if (now - lastTickAt >= 32) {
    lastTickAt = now;
    emitTick();
    updatePositionState();
    if (now - lastSaveAt > 5000) {
      lastSaveAt = now;
      saveResume();
    }
  }
  tickRaf = requestAnimationFrame(tick);
}

function startTicker() {
  if (tickRaf || document.hidden) return;
  lastTickAt = 0;
  tickRaf = requestAnimationFrame(tick);
}

function stopTicker() {
  if (tickRaf) cancelAnimationFrame(tickRaf);
  tickRaf = 0;
}

function saveResume(position) {
  const track = store.currentTrack;
  if (!track || store.status === 'error') return;
  const current = Number(position ?? audio.currentTime);
  const payload = {
    track: cleanTrack(track),
    queue: store.playQueue.slice(0, 120).map(cleanTrack).filter(Boolean),
    index: store.currentIndex,
    position: Number.isFinite(current) && current > 0 ? current : 0,
    savedAt: Date.now(),
  };
  saveJSON(KEYS.resume, payload);
  lastSaveAt = performance.now();
}

function setTrack(track) {
  store.currentTrack = track;
  document.title = track ? `${track.name} — ${track.artist} | PureTone` : 'PureTone';
  emit('player:track', {
    track,
    index: store.currentIndex,
    queue: store.playQueue,
  });
  if (track) updateMediaSession(track);
}

function hasSource() {
  return Boolean(loadedUrl) && audio.currentSrc === loadedUrl;
}

function markUnavailable(track) {
  if (!track) return;
  store.unavailable.add(String(track.id));
  emit('player:track', { track: store.currentTrack, index: store.currentIndex, queue: store.playQueue });
}

function failureMessage(error, track) {
  const reason = error?.reason;
  if (reason === 'login_required') return 'VIP / 付费歌曲，登录后才能播放';
  if (reason === 'vip_required') return '当前账号只能试听，暂时无法完整播放';
  if (reason === 'no_copyright') return '这首歌暂无版权或音源';
  if (reason === 'risk_control') return '账号触发风控，请稍后再试或重新登录';
  if (reason === 'upstream_error') return '音乐服务暂时不可用，稍后自动重试';
  if (reason === 'network') return '网络异常，音乐服务没有连上，稍后重试';
  if (error?.code === 'TIMEOUT' || error?.code === 'NETWORK') return '网络有点慢，歌曲没有加载出来';
  return error?.message || `《${track?.name || '这首歌'}》暂时无法播放`;
}

function fail(track, error, { auto = false } = {}) {
  stopTicker();
  loadedUrl = '';
  store.status = 'error';
  store.isPlaying = false;
  store.buffering = false;
  store.lastError = error?.message || '播放失败';
  markUnavailable(track);
  lastPositionAt = 0;
  emit('player:error', { track, error: { code: error?.code || 'PLAYBACK', message: failureMessage(error, track) } });
  setStatus('error');
  emitTick();

  const message = failureMessage(error, track);
  if (auto) {
    autoMode = true;
    const failures = Number(sessionStorage.getItem('pt_auto_failures') || 0) + 1;
    sessionStorage.setItem('pt_auto_failures', String(failures));
    if (failures >= MAX_AUTO_FAILURES) {
      sessionStorage.removeItem('pt_auto_failures');
      toast('连续 3 首都无法播放，已停止自动切换。请换一个板块或稍后重试。', 5200, 'error');
      return;
    }
    toast(`${message}，自动跳到下一首`, 3600, 'error');
    clearTimeout(failureTimer);
    failureTimer = setTimeout(() => {
      if (store.currentTrack?.id === track?.id) next({ auto: true });
    }, 1400);
    return;
  }

  toast(message, 4200, 'error');
}

function handleAudioError() {
  const track = store.currentTrack;
  if (!track || store.status === 'error') return;
  if (mediaRetry < 1) {
    mediaRetry += 1;
    store.status = 'loading';
    store.buffering = true;
    setStatus('loading');
    setTimeout(() => {
      if (!store.currentTrack || store.currentTrack.id !== track.id) return;
      const src = audio.currentSrc;
      if (!src) {
        fail(track, new Error(formatMediaError()), { auto: autoMode });
        return;
      }
      audio.load();
      audio.play().catch(() => {
        fail(track, new Error(formatMediaError()), { auto: autoMode });
      });
    }, 450);
    return;
  }
  fail(track, new Error(formatMediaError()), { auto: autoMode });
}

async function loadTrack(track, index, { mode = 'manual', position = 0, retry = 1 } = {}) {
  const myToken = ++token;
  autoMode = mode === 'auto';
  clearTimeout(failureTimer);
  failureTimer = 0;
  mediaRetry = 0;
  historyAdded = false;
  restorePosition = Number(position) || 0;
  pendingSeek = restorePosition > 0 ? restorePosition : null;

  urlController?.abort();
  urlController = new AbortController();
  loadedUrl = '';

  audio.pause();
  audio.removeAttribute('src');
  audio.load();

  store.playQueue = store.playQueue.slice();
  store.currentIndex = index;
  store.status = 'loading';
  store.buffering = true;
  store.isPlaying = false;
  store.lastError = null;
  setTrack(track);
  setStatus('loading');
  stopTicker();
  emitTick();

  try {
    const info = await getTrackUrl(track, {
      level: store.quality,
      signal: urlController.signal,
    });
    if (myToken !== token) return;
    if (!info?.url) {
      const error = new Error(info?.message || '没有可用的播放地址');
      error.reason = info?.reason || 'no_copyright';
      error.code = 'NO_SOURCE';
      throw error;
    }

    loadedUrl = new URL(info.url, location.href).href;
    audio.src = loadedUrl;
    audio.preload = 'auto';
    audio.load();
    await audio.play();
  } catch (error) {
    if (myToken !== token || error?.name === 'AbortError' || error?.code === 'ABORTED') return;
    if (error?.name === 'AbortError' || error?.code === 'ABORTED') return;

    if (retry > 0 && (error?.code === 'NETWORK' || error?.code === 'TIMEOUT')) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (myToken === token) {
        loadTrack(track, index, { mode, position: restorePosition, retry: retry - 1 });
      }
      return;
    }

    if (error?.name === 'NotAllowedError') {
      store.status = 'paused';
      store.buffering = false;
      setStatus('paused');
      toast('浏览器阻止了自动播放，点一下播放键即可继续', 3600);
      return;
    }
    fail(track, error, { auto: autoMode });
  }
}

export function playAt(index, options = {}) {
  if (index < 0 || index >= store.playQueue.length) return;
  const track = store.playQueue[index];
  if (!track) return;
  return loadTrack(track, index, options);
}

export function playFromList(tracks, index) {
  if (!Array.isArray(tracks) || !tracks.length) return;
  store.playQueue = tracks.slice();
  emit('player:queue', { queue: store.playQueue, index });
  return playAt(index);
}

export function playAll(tracks) {
  return playFromList(tracks, 0);
}

export function toggle() {
  if (!store.currentTrack) {
    // 空态起播同样遵守「只看可播放」，不能绕过界面筛掉隐藏的 VIP 歌。
    const list = playableTracks(store.playlist);
    if (list.length) return playAll(list);
    toast(store.filterPlayable ? '筛选后没有可播放的歌曲' : '先选一首歌吧');
    return;
  }
  if (store.status === 'error') {
    return playAt(store.currentIndex, { mode: 'manual', position: 0 });
  }
  if (hasSource() && !audio.error) {
    if (audio.paused) {
      audio.play().catch((error) => fail(store.currentTrack, error, { auto: false }));
    } else {
      audio.pause();
    }
    return;
  }
  playAt(store.currentIndex, { mode: 'manual', position: restorePosition });
}

export function next({ auto = false } = {}) {
  if (!store.playQueue.length) return;
  let nextIndex;
  if (store.shuffle && store.playQueue.length > 1) {
    do {
      nextIndex = Math.floor(Math.random() * store.playQueue.length);
    } while (nextIndex === store.currentIndex);
  } else {
    nextIndex = (store.currentIndex + 1) % store.playQueue.length;
  }
  return playAt(nextIndex, { mode: auto ? 'auto' : 'manual' });
}

export function prev() {
  if (!store.playQueue.length) return;
  if (hasSource() && audio.currentTime > 3) {
    seek(0);
    return;
  }
  const prevIndex = (store.currentIndex - 1 + store.playQueue.length) % store.playQueue.length;
  return playAt(prevIndex, { mode: 'manual' });
}

export function seek(seconds) {
  const target = Math.max(0, Number(seconds) || 0);
  if (!hasSource() || !Number.isFinite(audio.duration) || audio.duration <= 0) {
    restorePosition = target;
    pendingSeek = target;
    return;
  }
  audio.currentTime = Math.min(target, Math.max(0, audio.duration - 0.05));
  emitTick();
}

export function seekRatio(ratio) {
  const duration = getDuration();
  if (!duration) return;
  seek(Math.min(1, Math.max(0, ratio)) * duration);
}

export function getDuration() {
  if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  return Number(store.currentTrack?.duration) || 0;
}

export function getCurrentTime() {
  return Number(audio.currentTime) || 0;
}

// 拖动音量条时会高频触发 setVolume，localStorage 写入做防抖，
// 页面关闭（pagehide）时再刷盘，保证最终值不丢。
let settingsFlushTimer = 0;

function flushSettings() {
  clearTimeout(settingsFlushTimer);
  settingsFlushTimer = 0;
  saveSettings();
}

function saveSettingsSoon() {
  clearTimeout(settingsFlushTimer);
  settingsFlushTimer = setTimeout(flushSettings, 350);
}

window.addEventListener('pagehide', () => {
  if (settingsFlushTimer) flushSettings();
});

export function setVolume(value) {
  const volume = Math.min(1, Math.max(0, Number(value) || 0));
  store.volume = volume;
  store.muted = false;
  audio.muted = false;
  audio.volume = volume;
  saveSettingsSoon();
  emit('player:volume', { volume, muted: false });
}

export function adjustVolume(delta) {
  setVolume(store.volume + delta);
}

export function toggleMute() {
  store.muted = !store.muted;
  audio.muted = store.muted;
  saveSettings();
  emit('player:volume', { volume: store.volume, muted: store.muted });
  toast(store.muted ? '已静音' : '已取消静音', 1400);
}

export function toggleShuffle() {
  store.shuffle = !store.shuffle;
  saveSettings();
  emit('player:shuffle', { shuffle: store.shuffle });
  toast(store.shuffle ? '随机播放已开启' : '顺序播放', 1600);
}

export function removeAt(index) {
  if (index < 0 || index >= store.playQueue.length || index === store.currentIndex) {
    toast('不能移除正在播放的歌曲', 1800);
    return false;
  }
  store.playQueue.splice(index, 1);
  if (index < store.currentIndex) store.currentIndex -= 1;
  emit('player:queue', { queue: store.playQueue, index: store.currentIndex });
  toast('已从队列移除', 1600);
  saveResume();
  return true;
}

/** 队列拖拽重排：挪到 from → to，整体 index 语义不变。 */
export function move(from, to) {
  const total = store.playQueue.length;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
  if (from === to || from < 0 || to < 0 || from >= total || to >= total) return false;
  const [track] = store.playQueue.splice(from, 1);
  store.playQueue.splice(to, 0, track);
  let currentIndex = store.currentIndex;
  if (currentIndex === from) currentIndex = to;
  else if (from < currentIndex && to >= currentIndex) currentIndex -= 1;
  else if (from > currentIndex && to <= currentIndex) currentIndex += 1;
  store.currentIndex = currentIndex;
  emit('player:queue', { queue: store.playQueue, index: currentIndex });
  saveResume();
  return true;
}

export function restore() {
  const saved = loadJSON(KEYS.resume, null);
  if (!saved || !saved.track || !Number.isFinite(saved.savedAt)) return null;
  if (Date.now() - saved.savedAt > RESUME_MAX_AGE) return null;
  const track = cleanTrack(saved.track);
  if (!track) return null;
  const queue = Array.isArray(saved.queue) ? saved.queue.map(cleanTrack).filter(Boolean) : [track];
  if (!queue.length) queue.push(track);
  let index = Number(saved.index);
  if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
    index = queue.findIndex((item) => item.id === track.id);
  }
  if (index < 0) index = 0;
  store.playQueue = queue;
  store.currentIndex = index;
  restorePosition = Number(saved.position) || 0;
  pendingSeek = restorePosition > 0 ? restorePosition : null;
  store.status = 'paused';
  store.isPlaying = false;
  store.buffering = false;
  setTrack(track);
  emit('player:queue', { queue: store.playQueue, index });
  setStatus('paused');
  emitTick();
  return { track, position: restorePosition };
}

export function init() {
  if (initialized) return;
  initialized = true;
  audio.volume = store.volume;
  audio.muted = store.muted;

  audio.addEventListener('play', () => {
    store.isPlaying = true;
    if (store.status !== 'playing') setStatus(store.buffering ? 'buffering' : 'playing');
    startTicker();
  });

  audio.addEventListener('playing', () => {
    store.status = 'playing';
    store.isPlaying = true;
    store.buffering = false;
    store.unavailable.delete(String(store.currentTrack?.id));
    sessionStorage.removeItem('pt_auto_failures');
    setStatus('playing');
    startTicker();
    updatePositionState(true);
    if (!historyAdded && store.currentTrack) {
      historyAdded = true;
      addToHistory(store.currentTrack);
      saveResume();
    }
  });

  audio.addEventListener('pause', () => {
    stopTicker();
    if (store.status === 'error' || store.status === 'loading') return;
    store.isPlaying = false;
    store.buffering = false;
    setStatus('paused');
    emitTick();
    saveResume();
  });

  audio.addEventListener('waiting', () => {
    if (audio.paused) return;
    store.buffering = true;
    if (store.status !== 'error') setStatus('buffering');
  });

  audio.addEventListener('stalled', () => {
    if (audio.paused) return;
    store.buffering = true;
    if (store.status !== 'error') setStatus('buffering');
  });

  audio.addEventListener('canplay', () => {
    if (!audio.paused) startTicker();
  });

  audio.addEventListener('timeupdate', () => {
    updatePositionState();
    if (audio.paused) emitTick();
  });

  audio.addEventListener('durationchange', () => emitTick());

  audio.addEventListener('seeked', () => {
    emitTick();
    updatePositionState(true);
  });

  audio.addEventListener('loadedmetadata', () => {
    if (pendingSeek !== null && Number.isFinite(audio.duration)) {
      const target = Math.min(pendingSeek, Math.max(0, audio.duration - 0.1));
      pendingSeek = null;
      try {
        audio.currentTime = target;
      } catch {
        // 元数据刚就绪时个别浏览器会拒绝，下一次 seek 会再处理。
      }
    }
    emitTick();
  });

  audio.addEventListener('ended', () => {
    saveResume(0);
    next({ auto: true });
  });

  audio.addEventListener('error', handleAudioError);

  audio.addEventListener('volumechange', () => {
    store.volume = audio.volume;
    store.muted = audio.muted;
    // 持久化交给 setVolume 的 350ms 防抖与 toggleMute 的即时写盘，这里不再重复写。
    emit('player:volume', { volume: audio.volume, muted: audio.muted });
  });

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', () => toggle());
      navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => prev());
      navigator.mediaSession.setActionHandler('nexttrack', () => next());
      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        seek(getCurrentTime() - (details.seekOffset || 10));
      });
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        seek(getCurrentTime() + (details.seekOffset || 10));
      });
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (Number.isFinite(details.seekTime)) seek(details.seekTime);
      });
    } catch {
      // 个别浏览器只实现了部分 action，缺失项不影响播放。
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopTicker();
      saveResume();
    } else if (!audio.paused) {
      startTicker();
    }
  });

  window.addEventListener('pagehide', () => saveResume());
  window.addEventListener('beforeunload', () => saveResume());

  emit('player:volume', { volume: store.volume, muted: store.muted });
  emit('player:shuffle', { shuffle: store.shuffle });
}

export function getAudio() {
  return audio;
}

export function hasResume() {
  return Boolean(store.currentTrack && !hasSource());
}
