import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { CACHE_TTL, COOKIE, LEVELS, SECTIONS, UPSTREAM } from './config.js';
import { del, delPrefix, stats, wrap } from './cache.js';

const UA = 'PureTone/1.0 (+local personal player)';
const UPSTREAM_TIMEOUT = 9000;

const COOKIE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.login-cookie');

// —— 运行时登录态 ——
// 优先级：环境变量 > 扫码登录（写到 .login-cookie，仅本机回环，已加入 .gitignore）。
let runtimeCookie = COOKIE;
if (!runtimeCookie) {
  try {
    runtimeCookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim() || COOKIE;
  } catch {
    runtimeCookie = COOKIE;
  }
}

function setRuntimeCookie(value) {
  runtimeCookie = value || '';
  try {
    if (runtimeCookie) fs.writeFileSync(COOKIE_FILE, runtimeCookie, 'utf8');
    else fs.rmSync(COOKIE_FILE, { force: true });
  } catch {
    // 磁盘不可用时只保留内存态，重启重新扫码即可。
  }
  // 登录态变化会让同一首歌的取流结果不同，音频缓存整体失效；
  // 账号板块（每日推荐/喜欢的歌）也随登录态变化重取。
  delPrefix('audio:');
  delPrefix('section:');
}

export function loginState() {
  return { logged: Boolean(runtimeCookie), source: COOKIE ? 'env' : runtimeCookie ? 'qr' : 'none' };
}

export class ApiError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

function toHttps(url) {
  return typeof url === 'string' ? url.replace(/^http:\/\//i, 'https://') : url;
}

function withCoverSize(url) {
  if (!url) return '';
  const https = toHttps(url);
  return https + (https.includes('?') ? '&' : '?') + 'param=300y300';
}

export function normalizeTrack(song) {
  if (!song || song.id === undefined || song.id === null) return null;
  const album = song.al || song.album || {};
  const artists = song.ar || song.artists || [];
  const fee = Number(song.fee ?? song.privilege?.fee ?? 0);
  return {
    id: String(song.id),
    name: String(song.name || '未知歌曲'),
    artist: artists.map((a) => a?.name).filter(Boolean).join(' / ') || '未知歌手',
    album: String(album.name || '未知专辑'),
    duration: Math.floor(Number(song.dt || song.duration || 0) / 1000),
    cover: withCoverSize(album.picUrl || album.cover || '') || '/assets/cover.svg',
    fee,
    vip: fee === 1,
    paid: fee === 4,
    mv: Number(song.mv || 0),
  };
}

export async function upstream(path, params = {}, options = {}) {
  // 高峰期上游偶发超时：超时类错误自动重试一次（1s 退避），其余错误不重试。
  try {
    return await upstreamOnce(path, params, options);
  } catch (error) {
    if (error?.code !== 'UPSTREAM_TIMEOUT' || options.noRetry) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return upstreamOnce(path, params, { ...options, noRetry: true });
  }
}

async function upstreamOnce(path, params, options) {
  const url = new URL(UPSTREAM + (path.startsWith('/') ? path : '/' + path));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const cookie = options.cookie ?? runtimeCookie;
  if (cookie) url.searchParams.set('cookie', cookie);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || UPSTREAM_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!res.ok) {
      throw new ApiError('UPSTREAM_HTTP', `上游返回 HTTP ${res.status}`, res.status === 404 ? 404 : 502);
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new ApiError('UPSTREAM_FORMAT', '上游返回了非 JSON 数据', 502);
    }
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === 'AbortError') {
      throw new ApiError('UPSTREAM_TIMEOUT', '上游请求超时', 504);
    }
    throw new ApiError('UPSTREAM_NETWORK', '无法连接音乐接口', 502);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCategoryPlaylist(cat) {
  return wrap(`category:${cat}`, CACHE_TTL.category, async () => {
    const data = await upstream('/top/playlist', { cat, limit: 6, order: 'hot' });
    const list = data?.playlists || [];
    if (!list.length) throw new ApiError('NO_PLAYLIST', '没有找到这个分类的歌单', 404);
    const target =
      list.find((item) => !String(item.name || '').includes('全集') && !String(item.name || '').includes('专享')) ||
      list[0];
    return { id: String(target.id), name: String(target.name || cat) };
  });
}

// —— 账号板块：每日推荐 / 我喜欢的歌曲 / 账号资料（都需要登录 cookie）——

const ACCOUNT_SECTIONS = {
  daily: { type: 'account', title: '每日推荐', subtitle: '根据你的口味每天更新' },
  likes: { type: 'account', title: '我喜欢的歌曲', subtitle: '网易云账号云端的收藏' },
};

export async function getAccountProfile() {
  if (!runtimeCookie) return { logged: false, profile: null };
  const data = await upstream('/user/account');
  const profile = data?.profile;
  if (!profile) return { logged: false, profile: null };
  return {
    logged: true,
    profile: {
      uid: profile.userId,
      nickname: profile.nickname || '已登录',
      avatar: toHttps(profile.avatarUrl || ''),
      vip: Number(profile.vipType || 0) > 0,
    },
  };
}

export async function getDailySongs() {
  const data = await upstream('/recommend/songs');
  if (data?.code && data.code !== 200) {
    throw new ApiError('LOGIN_REQUIRED', '登录后可用每日推荐', 401);
  }
  return (data?.data?.dailySongs || []).slice(0, 80).map(normalizeTrack).filter(Boolean);
}

export async function getLikedSongs() {
  const account = await upstream('/user/account');
  const uid = account?.profile?.userId;
  if (!uid) throw new ApiError('LOGIN_REQUIRED', '登录后可见你的收藏', 401);
  const playlists = await upstream('/user/playlist', { uid, limit: 5 });
  // specialType 5 正是"我喜欢的音乐"私密歌单；兜底取第一张
  const likes = playlists?.playlist?.find((p) => p.specialType === 5) || playlists?.playlist?.[0];
  if (!likes?.id) return [];
  return getPlaylistTracks(String(likes.id), 60);
}

export async function getPlaylistTracks(playlistId, limit = 80) {
  return wrap(`tracks:${playlistId}:${limit}`, CACHE_TTL.tracks, async () => {
    const data = await upstream('/playlist/track/all', { id: playlistId, limit });
    let songs = data?.songs;
    if (!songs?.length) {
      const detail = await upstream('/playlist/detail', { id: playlistId });
      songs = detail?.playlist?.tracks || [];
    }
    return (songs || []).map(normalizeTrack).filter(Boolean);
  });
}

export async function getSection(key) {
  const accountConfig = ACCOUNT_SECTIONS[key];
  if (accountConfig) {
    return wrap(`section:${key}`, CACHE_TTL.section, async () => {
      if (!runtimeCookie) throw new ApiError('LOGIN_REQUIRED', '该板块需要登录网易云账号', 401);
      const tracks = key === 'daily' ? await getDailySongs() : await getLikedSongs();
      return {
        key,
        type: accountConfig.type,
        title: accountConfig.title,
        subtitle: accountConfig.subtitle,
        playlistId: '',
        playlistName: accountConfig.title,
        tracks,
        updatedAt: Date.now(),
      };
    });
  }
  const config = SECTIONS[key];
  if (!config) throw new ApiError('UNKNOWN_SECTION', '未知板块', 404);

  return wrap(`section:${key}`, CACHE_TTL.section, async () => {
    // 分类板块固定歌单 id，省掉「先查歌单、再查歌曲」的串行 RTT。
    let playlistId = config.playlistId || config.id;
    let playlistName = config.title;
    if (!playlistId && config.type === 'cat') {
      const resolved = await resolveCategoryPlaylist(config.cat);
      playlistId = resolved.id;
      playlistName = resolved.name;
    }
    const tracks = await getPlaylistTracks(playlistId, config.limit || 80);
    return {
      key,
      type: config.type,
      title: config.title,
      subtitle: config.subtitle,
      playlistId,
      playlistName,
      tracks,
      updatedAt: Date.now(),
    };
  });
}

export async function search(keyword, limit = 60) {
  const query = String(keyword || '').trim().slice(0, 60);
  if (!query) return { keyword: '', tracks: [] };

  return wrap(`search:${query}:${limit}`, CACHE_TTL.search, async () => {
    let data = await upstream('/cloudsearch', { keywords: query, type: 1, limit });
    let songs = data?.result?.songs;
    if (!songs?.length) {
      data = await upstream('/search', { keywords: query, type: 1, limit });
      songs = data?.result?.songs || [];
    }
    return {
      keyword: query,
      tracks: (songs || []).map(normalizeTrack).filter(Boolean),
    };
  });
}

export async function getLyric(id) {
  return wrap(`lyric:${id}`, CACHE_TTL.lyric, async () => {
    const data = await upstream('/lyric', { id });
    return {
      lrc: data?.lrc?.lyric || '',
      tlyric: data?.tlyric?.lyric || '',
      yrc: data?.yrc?.lyric || '',
      klyric: data?.klyric?.lyric || '',
    };
  });
}

export async function getComments(id, limit = 20) {
  return wrap(`comments:${id}:${limit}`, CACHE_TTL.comments, async () => {
    const data = await upstream('/comment/music', { id, limit });
    const hot = Array.isArray(data?.hotComments) ? data.hotComments : [];
    const all = Array.isArray(data?.comments) ? data.comments : [];
    const seen = new Set();
    const list = [];
    for (const item of [...hot, ...all]) {
      const key = String(item?.commentId || item?.id || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      list.push(item);
      if (list.length >= limit) break;
    }
    return {
      total: Number(data?.total || 0),
      comments: list.map((item) => ({
        id: String(item.commentId || item.id || ''),
        content: String(item.content || ''),
        liked: Number(item.likedCount || 0),
        time: Number(item.time || 0),
        timeStr: String(item.timeStr || ''),
        user: {
          nickname: String(item.user?.nickname || '匿名用户'),
          avatar: toHttps(item.user?.avatarUrl || ''),
        },
      })),
    };
  });
}

export async function getSimilar(id) {
  return wrap(`similar:${id}`, CACHE_TTL.similar, async () => {
    const data = await upstream('/simi/song', { id });
    return { tracks: (data?.songs || []).map(normalizeTrack).filter(Boolean) };
  });
}

function levelChain(level) {
  const index = LEVELS.indexOf(level);
  if (index < 0) return ['standard'];
  return [...new Set([level, ...LEVELS.slice(0, index).reverse()])];
}

export async function getTrackUrl(id, { fee = 0, level = 'standard' } = {}) {
  if (!/^\d+$/.test(String(id))) throw new ApiError('BAD_ID', '歌曲 id 不合法', 400);

  if (runtimeCookie) {
    let lastReason = 'no_copyright';
    for (const quality of levelChain(level)) {
      try {
        const data = await upstream('/song/url/v1', {
          id,
          level: quality,
          encodeType: quality === 'lossless' ? 'flac' : 'mp3',
        });
        if (Number(data?.code) === -462 || Number(data?.code) === 301) {
          setRuntimeCookie('');
          throw new ApiError('RISK_CONTROL', '登录状态已失效，请重新扫码登录', 401);
        }
        const item = data?.data?.[0];
        if (item?.url) {
          return {
            url: toHttps(item.url),
            level: item.level || quality,
            br: Number(item.br || 0),
            size: Number(item.size || 0),
            trial: Boolean(item.freeTrialInfo),
            expireAt: Date.now() + Math.max(60, Number(item.expi || 3600)) * 1000,
            reason: null,
          };
        }
        if (item?.freeTrialInfo) lastReason = 'vip_required';
      } catch (error) {
        if (error?.code === 'RISK_CONTROL') throw error;
        lastReason = error.code === 'UPSTREAM_TIMEOUT' ? 'network' : 'no_copyright';
      }
    }
    return {
      url: null,
      reason: lastReason,
      message:
        lastReason === 'vip_required'
          ? '这首歌需要 VIP，当前账号只能试听'
          : lastReason === 'network'
            ? '获取播放地址超时'
            : '该歌曲暂无版权或音源',
    };
  }

  if (fee === 1 || fee === 4) {
    return {
      url: null,
      reason: 'login_required',
      message: 'VIP / 付费歌曲，登录后可播放',
    };
  }

  // 匿名模式：不再请求注定 404 的 /song/url/v1。
  // 由本地后端代理音频流，既避免 http 混合内容，也能统一错误处理。
  return {
    url: `/api/audio/${encodeURIComponent(id)}`,
    level: 'standard',
    br: 0,
    size: 0,
    trial: false,
    expireAt: Date.now() + 2 * 60 * 60 * 1000,
    reason: null,
  };
}

async function resolveAudioUrl(id) {
  return wrap(`audio:${id}`, CACHE_TTL.audio, async () => {
    // 已登录：直接走完整音源接口拿 CDN 地址（https，可试听/完整播放）。
    if (runtimeCookie) {
      const info = await getTrackUrl(id, { level: 'exhigh' });
      if (info.url) return info.url;
      throw new ApiError('NO_AUDIO', info.message || '该歌曲暂无可用音源', 404);
    }

    // 匿名：免费外链兜底链。
    const target = `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`;

    // 匿名：免费外链兜底链。探测请求都要带超时，CDN 卡死不能拖死连接。
    let res = await fetch(target, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
      headers: { 'user-agent': UA },
    });
    let type = res.headers.get('content-type') || '';
    if (/audio/i.test(type)) return res.url;

    // 少数 CDN 不支持 HEAD，退回 Range 探测。
    res = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
      headers: { 'user-agent': UA, Range: 'bytes=0-0' },
    });
    type = res.headers.get('content-type') || '';
    const finalUrl = res.url;
    await res.body?.cancel().catch(() => {});
    if (!/audio/i.test(type)) {
      throw new ApiError('NO_AUDIO', '该歌曲暂无可用音源', 404);
    }
    return finalUrl;
  });
}

export async function proxyAudio(id, req, res) {
  const range = req.headers.range;
  const requestUpstream = (url) =>
    fetch(url, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      redirect: 'follow',
      // CDN 偶发挂起：探测+拉流全程限时，防止 socket 被永久占用。
      signal: AbortSignal.timeout(20000),
      headers: {
        'user-agent': UA,
        ...(range ? { Range: range } : {}),
      },
    });

  let finalUrl = await resolveAudioUrl(id);
  let upstreamRes = await requestUpstream(finalUrl);

  const isAudio = (response) =>
    (response.status === 200 || response.status === 206) &&
    /audio/i.test(response.headers.get('content-type') || '');

  if (!isAudio(upstreamRes)) {
    await upstreamRes.body?.cancel().catch(() => {});
    del(`audio:${id}`);
    finalUrl = await resolveAudioUrl(id);
    upstreamRes = await requestUpstream(finalUrl);
  }

  if (!isAudio(upstreamRes)) {
    await upstreamRes.body?.cancel().catch(() => {});
    throw new ApiError('NO_AUDIO', '该歌曲暂无可用音源', 404);
  }

  const headers = {
    'Content-Type': upstreamRes.headers.get('content-type') || 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  for (const name of ['content-length', 'content-range', 'last-modified', 'etag']) {
    const value = upstreamRes.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(upstreamRes.status, headers);
  if (req.method === 'HEAD' || !upstreamRes.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(upstreamRes.body), res);
}

// —— 扫码登录（复用 uni-netease 二维码接口，全程本地回环）——

/** 创建二维码：{ key, qrimg(dataURL) }；过期或失败按 ApiError 抛出。 */
export async function loginQrCreate() {
  const keyData = await upstream('/login/qr/key', { timestamp: Date.now() }, { cookie: '' });
  const key = keyData?.data?.unikey || keyData?.unikey || keyData?.code;
  if (!key) throw new ApiError('LOGIN_QR', '上游未返回登录 key', 502);
  const qr = await upstream('/login/qr/create', { key, qrimg: 1, timestamp: Date.now() }, { cookie: '' });
  const qrimg = qr?.data?.qrimg || qr?.qrimg || '';
  return { key, qrimg };
}

/**
 * 轮询二维码状态：
 * 800 过期 / 801 等待扫码 / 802 已扫码待确认 / 200 或 803 登录成功。
 */
export async function loginQrCheck(key) {
  if (!/^[0-9a-zA-Z-]+$/.test(String(key || ''))) throw new ApiError('BAD_KEY', 'key 不合法', 400);
  const data = await upstream('/login/qr/check', { key, timestamp: Date.now() }, { cookie: '' });
  const code = Number(data?.code ?? data?.data?.code);
  let status = 'waiting';
  if (code === 800) status = 'expired';
  else if (code === 802) status = 'scanned';
  else if (code === 200 || code === 803) status = 'success';
  else if (code !== 801) status = `code_${code}`;

  if (status === 'success') {
    const cookieStr = data?.cookie || data?.data?.cookie || '';
    if (cookieStr) {
      const musicU = String(cookieStr).match(/MUSIC_U=([^;\s]+)/)?.[1];
      setRuntimeCookie(musicU ? `MUSIC_U=${musicU}` : String(cookieStr).trim());
    }
    let nickname = '';
    try {
      const account = await upstream('/user/account');
      nickname = String(account?.profile?.nickname || '');
    } catch {
      nickname = '';
    }
    return { status, nickname };
  }
  if (!/^(expired|scanned|waiting)$/.test(status) && data?.message) {
    throw new ApiError('LOGIN_QR_CHECK', String(data.message), 502);
  }
  return { status };
}

export function logout() {
  setRuntimeCookie('');
  return { ok: true };
}

export function sectionsMeta() {
  return Object.entries(SECTIONS).map(([key, value]) => ({
    key,
    type: value.type,
    id: value.id || value.cat,
    title: value.title,
    subtitle: value.subtitle,
  }));
}

export { stats };

export async function warmSections(log = console.log) {
  // 先预热首屏，再低优先级逐个补齐其它板块；用户点到时基本已就绪。
  await new Promise((resolve) => setTimeout(resolve, 700));
  for (const key of Object.keys(SECTIONS)) {
    try {
      const data = await getSection(key);
      log(`[warm] ${key} → ${data.tracks.length} 首`);
    } catch (error) {
      log(`[warm] ${key} 失败：${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
}
