// 本地后端地址：开发用本机回环；上线换成 https 域名。
// 注意：小程序只允许 https（开发可勾选"不校验合法域名"临时放行 http://127.0.0.1）。
const DEV = 'http://127.0.0.1:8787';
const PROD = 'https://your-domain.example'; // TODO: 部署后替换

const BASE = DEV;

function request(path, { method = 'GET', data = null, timeout = 9000 } = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${BASE}${path}`,
      method,
      data: data || undefined,
      timeout,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          reject({ code: 'HTTP_' + res.statusCode, message: (res.data && res.data.error && res.data.error.message) || `HTTP ${res.statusCode}` });
        }
      },
      fail: (err) => reject({ code: 'NETWORK', message: err.errMsg || '网络请求失败' }),
    });
  });
}

const api = {
  health: () => request('/api/health'),
  section: (key) => request(`/api/section/${encodeURIComponent(key)}`),
  search: (q, limit = 60) => request(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  lyric: (id) => request(`/api/track/${id}/lyric`),
};

/** 板块清单（与 server/config.js 的 SECTIONS key 对齐）。 */
const SECTIONS = [
  { key: 'top_19723756', title: '飙升榜' },
  { key: 'top_3778678', title: '热歌榜' },
  { key: 'cat_华语', title: '华语精选' },
  { key: 'cat_欧美', title: '欧美精选' },
  { key: 'cat_摇滚', title: '摇滚现场' },
  { key: 'cat_学习', title: '学习陪伴' },
];

/** 简易 LRC 解析：[mm:ss.xx] → { t, text }。 */
function parseLyrics(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\](.*)$/);
      if (!m) return null;
      return {
        t: Number(m[1]) * 60 + Number(m[2]) + Number(m[3] || 0) / 1000,
        text: (m[4] || '').trim(),
      };
    })
    .filter((x) => x && x.text)
    .sort((a, b) => a.t - b.t);
}

/** 当前时间对应的歌词行下标（二分）。 */
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

module.exports = { BASE, api, SECTIONS, parseLyrics, lyricIndexAt };
