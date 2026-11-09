// 后端 API 封装：统一会话令牌、错误分类、板块清单。
// 地址来自 config.js（单一来源），不要在本文件写死 IP / 域名。
const { BASE_URL } = require('../config.js');

// 兼容旧调用：app.js 等曾从本模块取 BASE；现指向 config 的 BASE_URL。
const BASE = BASE_URL;

// —— 会话令牌 ——
// 后端 GET /api/session 返回 { token, exposeLan }；其余敏感接口要求
// 头 X-PureTone-Token: <token>。token 只在内存缓存，不落盘。
let token = '';
let sessionInfo = null;
let sessionPromise = null;

/** 把同源相对路径补成绝对 URL（音频 src 必须是完整地址，不能是 /api/... 相对路径）。 */
function absoluteUrl(url) {
  const u = String(url || '');
  if (/^https?:\/\//i.test(u)) return u;
  return `${BASE_URL}${u.charAt(0) === '/' ? '' : '/'}${u}`;
}

/** 从各种可能的响应体里提取语义 reason。 */
function pickReason(data) {
  if (!data || typeof data !== 'object') return '';
  return data.reason
    || (data.error && (data.error.reason || data.error.code))
    || '';
}

const REASON_MESSAGE = {
  no_copyright: '这首歌暂无版权音源',
  login_required: 'VIP/付费歌曲，请先在网页版扫码登录',
  risk_control: '账号触发风控，请稍后再试',
  upstream_error: '上游音乐服务暂时不可用，稍后再试',
  no_audio: '这首歌暂无可用音源',
};

/** 把语义 reason 包装成统一错误对象（供页面 ERROR_TEXT 查表 / 直接显示 message）。 */
function reasonError(reason, fallback, statusCode) {
  const r = reason || 'no_audio';
  return {
    code: r === 'no_audio' ? 'NO_AUDIO' : String(r).toUpperCase(),
    reason: r,
    statusCode,
    message: REASON_MESSAGE[r] || fallback || '这首歌暂时无法播放',
  };
}

/** 非 2xx 响应 → 统一错误对象；绝不把 5xx / 上游故障伪装成「无版权」。 */
function normalizeError(res) {
  const statusCode = res.statusCode;
  const reason = pickReason(res.data);
  if (reason && REASON_MESSAGE[reason]) {
    return reasonError(reason, null, statusCode);
  }
  if (statusCode === 403) {
    return {
      code: 'HTTP_403', reason: 'session', statusCode,
      message: '会话已失效，正在重试；若持续失败请重开小程序或检查后端',
    };
  }
  if (statusCode === 404) {
    // 404 = 无音源 / 无此歌，不再当成「无版权」
    return reasonError('no_audio', null, statusCode);
  }
  if (statusCode >= 500) {
    // 后端 / 上游故障：明确区分，不显示成「无版权」
    return reasonError('upstream_error', null, statusCode);
  }
  return {
    code: 'HTTP_' + statusCode,
    reason: '',
    statusCode,
    message: (res.data && res.data.error && res.data.error.message) || `请求失败（HTTP ${statusCode}）`,
  };
}

function normalizeNetwork(err) {
  const msg = (err && err.errMsg) || '';
  if (/timeout/i.test(msg)) {
    return {
      code: 'TIMEOUT', reason: 'network',
      message: '请求超时，请确认后端已启动、手机与电脑同一 WiFi',
    };
  }
  return {
    code: 'NETWORK', reason: 'network',
    message: '无法连接后端，请确认 EXPOSE_LAN=1、BASE 内网 IP 正确、同一 WiFi',
  };
}

/** 确保拿到 token；force=true 强制刷新（403 时用），并发请求共享同一个 in-flight。 */
function ensureSession(force = false) {
  if (!force && token) return Promise.resolve(token);
  if (!force && sessionPromise) return sessionPromise;
  if (force) token = '';
  const raw = new Promise((resolve, reject) => {
    wx.request({
      url: `${BASE_URL}/api/session`,
      method: 'GET',
      timeout: 8000,
      // /api/session 按契约无需 token
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const data = res.data || {};
          sessionInfo = data;
          token = data.token || '';
          if (token) resolve(token);
          else reject({ code: 'SESSION', reason: 'session', message: '后端未返回会话令牌，请确认 /api/session 已实现' });
        } else {
          reject({ code: 'SESSION', reason: 'session', message: `会话初始化失败（HTTP ${res.statusCode}），请确认后端已启动` });
        }
      },
      fail: (err) => reject(normalizeNetwork(err)),
    });
  });
  sessionPromise = raw.then(
    (t) => { sessionPromise = null; return t; },
    (e) => { sessionPromise = null; throw e; }
  );
  return sessionPromise;
}

function getSessionInfo() {
  return sessionInfo;
}

/** 带 token 的单次请求；403 时刷新 token 并只重试一次（allowRetry 防止死循环）。 */
function requestWithToken(path, opts, tk, allowRetry) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${BASE_URL}${path}`,
      method: opts.method || 'GET',
      data: opts.data || undefined,
      timeout: opts.timeout || 9000,
      header: Object.assign({ 'X-PureTone-Token': tk }, opts.header || {}),
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
          return;
        }
        if (res.statusCode === 403 && allowRetry) {
          ensureSession(true)
            .then((fresh) => requestWithToken(path, opts, fresh, false))
            .then(resolve, reject);
          return;
        }
        reject(normalizeError(res));
      },
      fail: (err) => reject(normalizeNetwork(err)),
    });
  });
}

function request(path, opts = {}) {
  return ensureSession().then((tk) => requestWithToken(path, opts, tk, true));
}

/** 板块清单以服务端为准，返回规范化 [{key,title}]；解析失败返回空数组由调用方兜底。 */
function normalizeSections(data) {
  let raw = data;
  // 兼容 { sections:[...] } / { sections:{ key:{...} } } / 直接数组 / 直接对象 四种形态
  if (data && !Array.isArray(data) && data.sections != null) raw = data.sections;
  if (Array.isArray(raw)) {
    return raw
      .map((s) => ({ key: s && (s.key || s.id), title: (s && (s.title || s.name)) || '' }))
      .filter((s) => s.key);
  }
  if (raw && typeof raw === 'object') {
    return Object.keys(raw)
      .map((key) => ({ key: (raw[key] && raw[key].key) || key, title: (raw[key] && raw[key].title) || key }))
      .filter((s) => s.key);
  }
  return [];
}

const api = {
  health: () => request('/api/health'),
  section: (key) => request(`/api/section/${encodeURIComponent(key)}`),
  // 板块列表以服务端为准（含「新歌榜」）；失败时由页面退回本地兜底 SECTIONS
  sections: () => request('/api/sections').then(normalizeSections),
  search: (q, limit = 60) => request(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  lyric: (id) => request(`/api/track/${encodeURIComponent(id)}/lyric`),
  user: () => request('/api/user', { timeout: 10000 }),
  // 取流门禁：成功返回同源 /api/audio/:id?level=...；失败按 reason 分类抛错
  trackUrl: (id) => request(`/api/track/${encodeURIComponent(id)}/url`).then((data) => {
    if (data && data.url) return data;
    throw reasonError(pickReason(data) || 'no_audio', null, 200);
  }),
  // 会话初始化（/api/session 本身无需 token，由 ensureSession 直连）
  session: () => ensureSession(),
};

// 公共板块兜底清单：与 server/config.js 的 SECTIONS 对齐（补「新歌榜」、统一「专注氛围」）。
// 运行时优先用 /api/sections 覆盖；此处仅当接口不可达时兜底。
const SECTIONS = [
  { key: 'top_19723756', title: '飙升榜' },
  { key: 'top_3778678', title: '热歌榜' },
  { key: 'top_3779629', title: '新歌榜' },
  { key: 'cat_华语', title: '华语精选' },
  { key: 'cat_欧美', title: '欧美精选' },
  { key: 'cat_摇滚', title: '摇滚现场' },
  { key: 'cat_学习', title: '专注氛围' },
];

/** 账号板块：需要服务端已登录（网页版扫码）；未登录时不可见 */
const ACCOUNT_SECTIONS = [
  { key: 'daily', title: '每日推荐', account: true },
  { key: 'likes', title: '我喜欢的歌曲', account: true },
];

/** 歌曲元数据行（LRC 开头的制作信息），不进歌词滚动区——与网页版 src/core/lyrics.js 对齐。 */
const CREDIT = /^(作词|作曲|编曲|制作人|出品|监制|混音|母带|录音|和声|吉他|贝斯|鼓|键盘|弦乐|发行|词|曲|翻译|OP|ED)\s*[:：]/;

/** 把 LRC 文本解析为 [{ t, text }]，按时间升序。 */
function parseLyrics(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\](.*)$/);
      if (!m) return null;
      // 百分秒(.50)按网页版语义补齐三位毫秒：'50' → '500' → 0.5s，不是 0.05s
      return {
        t: Number(m[1]) * 60 + Number(m[2]) + Number((m[3] || '0').padEnd(3, '0')) / 1000,
        text: (m[4] || '').trim(),
      };
    })
    .filter((x) => x && x.text && !CREDIT.test(x.text))
    .sort((a, b) => a.t - b.t);
}

/** 给定时间返回对应歌词行下标（二分）。 */
function lyricIndexAt(lines, t) {
  let lo = 0;
  let hi = lines.length - 1;
  if (!lines.length || t < lines[0].t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

module.exports = {
  BASE, api, SECTIONS, ACCOUNT_SECTIONS, parseLyrics, lyricIndexAt,
  ensureSession, getSessionInfo, absoluteUrl, normalizeSections,
};
