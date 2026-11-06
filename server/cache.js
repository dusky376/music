const store = new Map();
const inflight = new Map();
const MAX_ENTRIES = 240;
let hits = 0;
let misses = 0;

export function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expire <= Date.now()) {
    store.delete(key);
    return null;
  }
  hits += 1;
  return entry.value;
}

export function set(key, value, ttl) {
  if (store.size >= MAX_ENTRIES && !store.has(key)) {
    const now = Date.now();
    for (const [oldKey, entry] of store) {
      if (entry.expire <= now) store.delete(oldKey);
    }
    while (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
  }
  store.set(key, { value, expire: Date.now() + ttl });
}

export function del(key) {
  store.delete(key);
  inflight.delete(key);
}

/** 按 key 前缀批量失效（登录态变化时清音频缓存等）。 */
export function delPrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) inflight.delete(key);
  }
}

export async function wrap(key, ttl, fn) {
  const hit = get(key);
  if (hit !== null) return hit;
  if (inflight.has(key)) return inflight.get(key);
  misses += 1;
  const task = Promise.resolve()
    .then(fn)
    .then((value) => {
      set(key, value, ttl);
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, task);
  return task;
}

export function stats() {
  return { size: store.size, hits, misses, inflight: inflight.size };
}
