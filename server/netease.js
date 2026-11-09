import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import {
  CACHE_TTL,
  COOKIE,
  COOKIE_IN_QUERY,
  LEVELS,
  SECTIONS,
  UPSTREAM,
} from './config.js';
import { del, delPrefix, stats, wrap } from './cache.js';
import {
  GuardError,
  SECURITY_HEADERS,
  assertSafeAudioUrl,
  fetchGuardedAudio,
} from './security.js';

const UA = 'PureTone/1.0 (+local personal player)';
const UPSTREAM_TIMEOUT = 9000;
const AUDIO_HEADER_TIMEOUT = 12000;

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
// 测试/多实例可用 PURETONE_STATE_DIR 把凭据隔离到临时目录，避免误删真实登录态。
const STATE_DIR = process.env.PURETONE_STATE_DIR
  ? path.resolve(process.env.PURETONE_STATE_DIR)
  : SERVER_DIR;
const COOKIE_FILE = path.join(STATE_DIR, '.login-cookie');
// 退出登录后留下的标记：防止 NETEASE_COOKIE 环境变量或旧文件让登录态在重启后「复活」。
const LOGOUT_SENTINEL = path.join(STATE_DIR, '.logged-out');

// —— 运行时登录态 ——
// 优先级：环境变量 > 扫码登录写下的 .login-cookie。
// 若用户主动退出过（sentinel 存在），两者都不再自动恢复，必须重新扫码。
let explicitlyLoggedOut = false;
try {
  explicitlyLoggedOut = fs.existsSync(LOGOUT_SENTINEL);
} catch {
  explicitlyLoggedOut = false;
}

function readCookieFile() {
  try {
    return fs.readFileSync(COOKIE_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

let runtimeCookie = explicitlyLoggedOut ? '' : COOKIE || readCookieFile();
let cookieSource = runtimeCookie ? (COOKIE && runtimeCookie === COOKIE ? 'env' : 'qr') : 'none';
let riskControlHits = 0;

/** 写/删凭据。返回用户可见的告警（磁盘失败不再被静默吞掉）。 */
function setRuntimeCookie(value) {
  const warnings = [];
  runtimeCookie = String(value || '').trim();
  cookieSource = runtimeCookie ? 'qr' : 'none';
  explicitlyLoggedOut = !runtimeCookie;

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    if (runtimeCookie) {
      fs.writeFileSync(COOKIE_FILE, runtimeCookie, { encoding: 'utf8', mode: 0o600 });
      try {
        fs.chmodSync(COOKIE_FILE, 0o600);
      } catch {
        // Windows 上 chmod 可能不生效，尽力而为。
      }
      try {
        fs.rmSync(LOGOUT_SENTINEL, { force: true });
      } catch {
        warnings.push('退出标记清理失败');
      }
    } else {
      try {
        fs.rmSync(COOKIE_FILE, { force: true });
      } catch {
        warnings.push('本机凭据文件删除失败，请手动检查 server/.login-cookie');
      }
      try {
        fs.writeFileSync(LOGOUT_SENTINEL, String(Date.now()), { encoding: 'utf8', mode: 0o600 });
      } catch {
        warnings.push('退出状态无法持久化，重启后登录态可能恢复');
      }
    }
  } catch {
    warnings.push('凭据写入失败，本次登录仅在当前进程有效');
  }

  // 登录态变化会让同一首歌的取流结果不同，音频/板块缓存整体失效。
  delPrefix('audio:');
  delPrefix('direct:');
  delPrefix('section:');
  return warnings;
}

export function loginState() {
  return {
    logged: Boolean(runtimeCookie),
    source: runtimeCookie ? cookieSource : explicitlyLoggedOut ? 'logged_out' : 'none',
  };
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

export async function upstream(apiPath, params = {}, options = {}) {
  // 高峰期上游偶发超时：超时类错误自动重试一次（1s 退避），其余错误不重试。
  try {
    return await upstreamOnce(apiPath, params, options);
  } catch (error) {
    if (error?.code !== 'UPSTREAM_TIMEOUT' || options.noRetry) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return upstreamOnce(apiPath, params, { ...options, noRetry: true });
  }
}

async function upstreamOnce(apiPath, params, options) {
  const url = new URL(UPSTREAM + (apiPath.startsWith('/') ? apiPath : '/' + apiPath));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const headers = { 'user-agent': UA, accept: 'application/json' };
  const cookie = options.cookie ?? runtimeCookie;
  if (cookie) {
    if (COOKIE_IN_QUERY) {
      // 兼容开关：老版本上游只认 query。默认关闭，避免凭据落进访问日志。
      url.searchParams.set('cookie', cookie);
    } else {
      headers.cookie = cookie;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || UPSTREAM_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
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
  if (!profile) {
    // 凭据可能已失效，但也可能是上游临时抖动：只如实上报，不自动删除用户凭据。
    return { logged: false, profile: null, reason: 'credential_invalid' };
  }
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
  // specialType 5 正是「我喜欢的音乐」私密歌单；兜底取第一张
  const likes = playlists?.playlist?.find((p) => p.specialType === 5) || playlists?.playlist?.[0];
  if (!likes?.id) return [];
  // 全量拉取：trackCount 就是真实收藏数，按它取（上限 3000 兜底）。
  const total = Math.min(Number(likes.trackCount) || 0, 3000);
  const tracks = total > 0 ? await getPlaylistTracks(String(likes.id), total) : [];
  return { tracks, total: Number(likes.trackCount) || tracks.length };
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
      let tracks;
      let subtitle = accountConfig.subtitle;
      if (key === 'daily') {
        tracks = await getDailySongs();
        subtitle = `${tracks.length} 首 · 官方每日推送`;
      } else {
        const liked = await getLikedSongs();
        tracks = liked.tracks;
        subtitle = `云端收藏 ${liked.total} 首`;
      }
      return {
        key,
        type: accountConfig.type,
        title: accountConfig.title,
        subtitle,
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

// —— 取流：统一走 /api/audio/:id 本地代理，不再把 CDN 直链交给客户端 ——

function levelChain(level) {
  if (!LEVELS.includes(level)) throw new GuardError('BAD_LEVEL', '音质参数不合法', 400);
  const index = LEVELS.indexOf(level);
  return [...new Set([level, ...LEVELS.slice(0, index).reverse()])];
}

/** content-type 必须是真音频；`text/html; audio=1` 这类伪造标签不再能通过。 */
function isAudioType(type) {
  const value = String(type || '').split(';')[0].trim().toLowerCase();
  if (/html|json|xml|javascript|text\//.test(value)) return false;
  return value.startsWith('audio/') || value === 'application/octet-stream';
}

function noteRiskControl() {
  // -462/301 多为临时风控：只计数、保留凭据，绝不因为一次取流就清空用户登录态。
  riskControlHits += 1;
}

function upstreamReason(error) {
  if (error?.code === 'UPSTREAM_TIMEOUT') return 'network';
  if (error?.code === 'UPSTREAM_NETWORK' || error?.code === 'UPSTREAM_HTTP' || error?.code === 'UPSTREAM_FORMAT') {
    return 'upstream_error';
  }
  return 'no_copyright';
}

function reasonMessage(reason) {
  if (reason === 'vip_required') return '这首歌需要 VIP，当前账号只能试听';
  if (reason === 'upstream_error') return '音乐服务暂时不可用，请稍后重试';
  if (reason === 'network') return '获取播放地址超时，请稍后重试';
  return '该歌曲暂无版权或音源';
}

/**
 * 解析出可播放的真实上游地址（仅服务端内部使用，绝不返回给客户端）。
 * 登录态走 /song/url/v1；匿名走免费外链。所有 URL 都经过白名单校验。
 */
async function fetchDirectUrl(id, level = 'standard') {
  if (!/^\d+$/.test(String(id))) throw new GuardError('BAD_ID', '歌曲 id 不合法', 400);

  return wrap(`direct:${id}:${level}`, CACHE_TTL.audio, async () => {
    if (runtimeCookie) {
      let lastReason = 'no_copyright';
      for (const quality of levelChain(level)) {
        try {
          const data = await upstream('/song/url/v1', {
            id,
            level: quality,
            encodeType: quality === 'lossless' ? 'flac' : 'mp3',
          });
          const code = Number(data?.code);
          if (code === -462 || code === 301) {
            noteRiskControl();
            throw new ApiError('RISK_CONTROL', '登录状态触发风控，请稍后重试', 429);
          }
          const item = data?.data?.[0];
          if (item?.url) {
            riskControlHits = 0;
            return {
              url: assertSafeAudioUrl(item.url),
              level: LEVELS.includes(item.level) ? item.level : quality,
              br: Number(item.br || 0),
              size: Number(item.size || 0),
              trial: Boolean(item.freeTrialInfo),
              expireAt: Date.now() + Math.max(60, Number(item.expi || 3600)) * 1000,
            };
          }
          if (item?.freeTrialInfo) lastReason = 'vip_required';
        } catch (error) {
          if (error?.code === 'RISK_CONTROL' || error instanceof GuardError) throw error;
          lastReason = upstreamReason(error);
        }
      }
      throw new ApiError('NO_AUDIO', reasonMessage(lastReason), 404);
    }

    // 匿名：免费外链兜底链。逐跳校验 302 目标，避免上游被污染后打进内网。
    const target = `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`;
    const probeInit = { headers: { 'user-agent': UA } };
    let finalUrl = '';
    let ok = false;

    const head = await fetchGuardedAudio(target, { ...probeInit, method: 'HEAD' }, { headerTimeout: AUDIO_HEADER_TIMEOUT });
    finalUrl = head.finalUrl;
    ok = (head.response.status === 200 || head.response.status === 206) && isAudioType(head.response.headers.get('content-type'));
    await head.response.body?.cancel().catch(() => {});
    head.controller.abort();

    if (!ok) {
      // 少数 CDN 不支持 HEAD，退回 Range 探测。
      const ranged = await fetchGuardedAudio(
        target,
        { ...probeInit, method: 'GET', headers: { 'user-agent': UA, Range: 'bytes=0-0' } },
        { headerTimeout: AUDIO_HEADER_TIMEOUT }
      );
      finalUrl = ranged.finalUrl;
      ok =
        (ranged.response.status === 200 || ranged.response.status === 206) &&
        isAudioType(ranged.response.headers.get('content-type'));
      await ranged.response.body?.cancel().catch(() => {});
      ranged.controller.abort();
    }

    if (!ok) throw new ApiError('NO_AUDIO', '该歌曲暂无可用音源', 404);
    return {
      url: assertSafeAudioUrl(finalUrl),
      level: 'standard',
      br: 0,
      size: 0,
      trial: false,
      expireAt: Date.now() + CACHE_TTL.audio,
    };
  });
}

export async function getTrackUrl(id, { fee = 0, level = 'standard' } = {}) {
  if (!/^\d+$/.test(String(id))) throw new GuardError('BAD_ID', '歌曲 id 不合法', 400);
  if (!LEVELS.includes(level)) throw new GuardError('BAD_LEVEL', '音质参数不合法', 400);

  // fee 只用来给 UI 一个提前提示，真正的权限门禁由音源接口决定，不信任客户端传值。
  if (!runtimeCookie && (fee === 1 || fee === 4)) {
    return { url: null, reason: 'login_required', message: 'VIP / 付费歌曲，登录后可播放' };
  }

  try {
    const info = await fetchDirectUrl(id, level);
    const resolvedLevel = LEVELS.includes(info.level) ? info.level : level;
    return {
      url: `/api/audio/${encodeURIComponent(id)}?level=${encodeURIComponent(resolvedLevel)}`,
      level: resolvedLevel,
      br: info.br,
      size: info.size,
      trial: info.trial,
      expireAt: info.expireAt,
      reason: null,
    };
  } catch (error) {
    if (error?.code === 'RISK_CONTROL') {
      return { url: null, reason: 'risk_control', message: `账号触发风控（连续 ${riskControlHits} 次），请稍后重试或重新扫码登录` };
    }
    if (error?.code === 'NO_AUDIO') {
      return { url: null, reason: 'no_copyright', message: error.message };
    }
    if (error?.code === 'LOGIN_REQUIRED') {
      return { url: null, reason: 'login_required', message: error.message };
    }
    if (error instanceof GuardError || error?.code?.startsWith?.('AUDIO_') || error?.code === 'TOO_MANY_REDIRECTS') {
      console.error(`[audio] 音源被安全策略拒绝：${error.code || error.name}: ${error.message}`);
      return { url: null, reason: 'upstream_error', message: '音源地址异常，已阻止请求' };
    }
    return { url: null, reason: 'upstream_error', message: '音乐服务暂时不可用，请稍后重试' };
  }
}

function audioError(error) {
  if (error instanceof ApiError) return error;
  if (error instanceof GuardError) {
    return new ApiError(error.code, '音源地址异常或连接失败', error.status || 502);
  }
  return new ApiError('UPSTREAM_ERROR', '无法获取音频流', 502);
}

function sendRangeError(res, contentRange = 'bytes */0') {
  res.writeHead(416, {
    ...SECURITY_HEADERS,
    'Accept-Ranges': 'bytes',
    'Content-Range': contentRange,
    'Cache-Control': 'no-store',
  });
  res.end();
}

async function openAudioStream(id, level, req, range) {
  const info = await fetchDirectUrl(id, level);
  return fetchGuardedAudio(
    info.url,
    {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: { 'user-agent': UA, ...(range ? { Range: range } : {}) },
    },
    { headerTimeout: AUDIO_HEADER_TIMEOUT }
  );
}

export async function proxyAudio(id, req, res, { level = 'standard' } = {}) {
  const rawRange = req.headers.range ? String(req.headers.range).trim() : '';
  // Range 只允许单段、纯数字，避免把任意头透传给上游。
  if (rawRange && !/^bytes=\d*-\d*$/.test(rawRange)) {
    sendRangeError(res);
    return;
  }

  let stream;
  let streamController;
  try {
    stream = await openAudioStream(id, level, req, rawRange);
    streamController = stream.controller;

    const isAcceptable = (response) =>
      (response.status === 200 || response.status === 206) && isAudioType(response.headers.get('content-type'));

    if (!isAcceptable(stream.response)) {
      await stream.response.body?.cancel().catch(() => {});
      stream.controller.abort();
      // CDN 地址过期：清掉解析缓存后重试一次。
      del(`direct:${id}:${level}`);
      stream = await openAudioStream(id, level, req, rawRange);
      streamController = stream.controller;
    }

    const upstreamRes = stream.response;
    if (upstreamRes.status === 416) {
      await upstreamRes.body?.cancel().catch(() => {});
      streamController.abort();
      sendRangeError(res, upstreamRes.headers.get('content-range') || 'bytes */0');
      return;
    }
    if (!isAcceptable(upstreamRes)) {
      await upstreamRes.body?.cancel().catch(() => {});
      streamController.abort();
      throw new ApiError('NO_AUDIO', '该歌曲暂无可用音源', 404);
    }

    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': upstreamRes.headers.get('content-type') || 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    for (const name of ['content-length', 'content-range', 'last-modified', 'etag']) {
      const value = upstreamRes.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(upstreamRes.status, headers);
    // 客户端断开（切歌/关页面）时立刻停止拉上游，别让 CDN 连接挂着。
    res.on('close', () => {
      if (!res.writableEnded) streamController.abort();
    });

    if (req.method === 'HEAD' || !upstreamRes.body) {
      res.end();
      streamController.abort();
      return;
    }
    try {
      await pipeline(Readable.fromWeb(upstreamRes.body), res);
    } catch (error) {
      if (error?.code !== 'ERR_STREAM_PREMATURE_CLOSE' && error?.name !== 'AbortError') throw error;
    }
  } catch (error) {
    streamController?.abort();
    throw audioError(error);
  }
}

// —— 扫码登录（复用 uni-netease 二维码接口，全程本地回环）——

/** 创建二维码：{ key, qrimg(dataURL) }；上游缺字段一律报错，不拿 code 当 key。 */
export async function loginQrCreate() {
  const keyData = await upstream('/login/qr/key', { timestamp: Date.now() }, { cookie: '' });
  const key = keyData?.data?.unikey || keyData?.unikey;
  if (typeof key !== 'string' || !/^[0-9a-zA-Z_-]{8,}$/.test(key)) {
    throw new ApiError('LOGIN_QR', '上游未返回有效的登录 key', 502);
  }
  const qr = await upstream('/login/qr/create', { key, qrimg: 1, timestamp: Date.now() }, { cookie: '' });
  const qrimg = qr?.data?.qrimg || qr?.qrimg || '';
  if (typeof qrimg !== 'string' || !/^data:image\//i.test(qrimg)) {
    throw new ApiError('LOGIN_QR', '上游未返回二维码图片，请稍后重试', 502);
  }
  return { key, qrimg };
}

/**
 * 轮询二维码状态：
 * 800 过期 / 801 等待扫码 / 802 已扫码待确认 / 200 或 803 登录成功。
 * key 由 /api/login/qr 在本进程登记，index.js 会先校验会话归属。
 */
export async function loginQrCheck(key) {
  if (!/^[0-9a-zA-Z_-]+$/.test(String(key || ''))) throw new GuardError('BAD_KEY', 'key 不合法', 400);
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
      const warnings = setRuntimeCookie(musicU ? `MUSIC_U=${musicU}` : String(cookieStr).trim());
      if (warnings.length) console.warn('[login] 凭据落盘异常：', warnings.join('；'));
    }
    riskControlHits = 0;
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

/** 退出：清本机凭据 + 通知上游让云端 cookie 失效 + 留下防复活标记。 */
export async function logout() {
  const previous = runtimeCookie;
  const warnings = setRuntimeCookie('');
  riskControlHits = 0;
  let cloud = 'not_needed';
  if (previous) {
    try {
      await upstream('/logout', { timestamp: Date.now() }, { cookie: previous, noRetry: true, timeout: 5000 });
      cloud = 'ok';
    } catch {
      cloud = 'failed';
      warnings.push('未能通知云端使登录态失效，建议在网易云 App 中主动退出');
    }
  }
  return { ok: warnings.length === 0, cloud, warnings };
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
