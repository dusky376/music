import { readCache, writeCache } from './storage.js';

const DEFAULT_TIMEOUT = 10000;
const SECTION_MEMORY_TTL = 2 * 60 * 1000;
const SECTION_CACHE_TTL = 6 * 60 * 60 * 1000;

const memory = new Map();
const inflight = new Map();

export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

function abortError() {
  return new ApiError('ABORTED', '请求已取消', 0);
}

export async function request(path, { signal, timeout = DEFAULT_TIMEOUT } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw abortError();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const response = await fetch(path, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // 下面统一按状态码处理。
    }
    if (!response.ok) {
      const message = payload?.error?.message || `本地服务返回 ${response.status}`;
      throw new ApiError(payload?.error?.code || 'HTTP_ERROR', message, response.status);
    }
    if (!payload || typeof payload !== 'object') {
      throw new ApiError('BAD_PAYLOAD', '服务返回的数据格式不正确', 502);
    }
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal?.aborted) throw abortError();
    if (timedOut || error?.name === 'AbortError') {
      throw new ApiError('TIMEOUT', '加载超时，请检查网络后重试', 504);
    }
    throw new ApiError('NETWORK', '无法连接本地音乐服务', 0);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function getMemory(key, ttl) {
  const entry = memory.get(key);
  if (!entry) return null;
  if (Date.now() - entry.savedAt > ttl) {
    memory.delete(key);
    return null;
  }
  return entry.data;
}

function setMemory(key, data) {
  memory.set(key, { data, savedAt: Date.now() });
  if (memory.size > 80) {
    const oldest = memory.keys().next().value;
    memory.delete(oldest);
  }
}

export function peekSection(key) {
  const cached = readCache(`section:${key}`, SECTION_CACHE_TTL);
  if (!cached) return null;
  return {
    data: cached.data,
    savedAt: cached.savedAt,
    age: Date.now() - cached.savedAt,
  };
}

export async function getSection(key, { signal, force = false } = {}) {
  const memoryKey = `section:${key}`;
  if (!force) {
    const hit = getMemory(memoryKey, SECTION_MEMORY_TTL);
    if (hit) return hit;
  }

  let data;
  try {
    data = signal
      ? await request(`/api/section/${encodeURIComponent(key)}`, { signal, timeout: 12000 })
      : await dedupe(memoryKey, () =>
          request(`/api/section/${encodeURIComponent(key)}`, { timeout: 12000 })
        );
  } catch (error) {
    if (error.code === 'ABORTED') throw error;
    const cached = peekSection(key);
    if (cached) {
      return { ...cached.data, stale: true, cacheAge: cached.age };
    }
    throw error;
  }

  setMemory(memoryKey, data);
  writeCache(`section:${key}`, data);
  return data;
}

export async function prefetchSection(key) {
  const memoryKey = `section:${key}`;
  if (getMemory(memoryKey, SECTION_MEMORY_TTL)) return;
  const cached = peekSection(key);
  if (cached && Date.now() - cached.savedAt < SECTION_MEMORY_TTL) return;
  try {
    await getSection(key, { force: true });
  } catch {
    // 预取失败保持静默，等用户真正点击时再提示。
  }
}

export async function searchTracks(keyword, { signal } = {}) {
  const q = String(keyword || '').trim();
  if (!q) return { keyword: '', tracks: [] };
  return request(`/api/search?q=${encodeURIComponent(q)}&limit=60`, {
    signal,
    timeout: 10000,
  });
}

export function getTrackUrl(track, { level = 'standard', signal } = {}) {
  const fee = Number(track?.fee) || 0;
  return request(
    `/api/track/${encodeURIComponent(track.id)}/url?fee=${fee}&level=${encodeURIComponent(level)}`,
    { signal, timeout: 12000 }
  );
}

export function getLyric(id, { signal } = {}) {
  return request(`/api/track/${encodeURIComponent(id)}/lyric`, { signal, timeout: 12000 });
}

export function getComments(id, { limit = 20, signal } = {}) {
  return request(`/api/track/${encodeURIComponent(id)}/comments?limit=${limit}`, {
    signal,
    timeout: 10000,
  });
}

export function getSimilar(id, { signal } = {}) {
  return request(`/api/track/${encodeURIComponent(id)}/similar`, { signal, timeout: 10000 });
}

export async function getHealth() {
  return request('/api/health', { timeout: 4000 });
}

export function getLoginStatus() {
  return request('/api/login/status', { timeout: 8000 });
}

export function getUser() {
  return request('/api/user', { timeout: 10000 });
}

export function createLoginQr() {
  return request('/api/login/qr', { timeout: 15000 });
}

export function checkLoginQr(key) {
  return request(`/api/login/qr/check?key=${encodeURIComponent(key)}`, { timeout: 15000 });
}

export function logoutServer() {
  return request('/api/logout', { timeout: 8000 });
}

async function dedupe(key, factory) {
  if (inflight.has(key)) return inflight.get(key);
  const task = Promise.resolve()
    .then(factory)
    .finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

export function clearMemory() {
  memory.clear();
}
