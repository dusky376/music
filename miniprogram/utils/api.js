// 后端地址：本地调试直接跑 http://127.0.0.1:8787；
// 真机预览必须改成电脑的局域网 IP（下面 LAN_IP 生成，且手机电脑同一 WiFi）；
// 正式上线必须换成 https 已备案域名。
const LAN_IP = '192.168.4.12'; // 电脑局域网 IP（真机预览用；电脑 IP 变了就改这里）
const DEV = 'http://127.0.0.1:8787';       // 模拟器/工具内
const REAL_DEVICE = `http://${LAN_IP}:8787`; // 真机预览

const BASE = REAL_DEVICE;

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
      fail: (err) => reject({ code: 'NETWORK', message: err.errMsg || '网络连接失败' }),
    });
  });
}

const api = {
  health: () => request('/api/health'),
  section: (key) => request(`/api/section/${encodeURIComponent(key)}`),
  search: (q, limit = 60) => request(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  lyric: (id) => request(`/api/track/${id}/lyric`),
  // 登录态与个人资料（服务端共享登录态：网页版扫码后，小程序直接可用）
  user: () => request('/api/user', { timeout: 10000 }),
};

/** 公共板块清单（与 server/config.js 的 SECTIONS key 对应） */
const SECTIONS = [
  { key: 'top_19723756', title: '飙升榜' },
  { key: 'top_3778678', title: '热歌榜' },
  { key: 'cat_华语', title: '华语精选' },
  { key: 'cat_欧美', title: '欧美精选' },
  { key: 'cat_摇滚', title: '摇滚现场' },
  { key: 'cat_学习', title: '学习氛围' },
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

module.exports = { BASE, api, SECTIONS, ACCOUNT_SECTIONS, parseLyrics, lyricIndexAt };
