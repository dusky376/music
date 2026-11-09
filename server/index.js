import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  COOKIE,
  EXPOSE_LAN,
  EXTRA_ORIGINS,
  HOST,
  LAN_IP,
  LEVELS,
  PORT,
  ROOT,
  UPSTREAM,
  WARM,
} from './config.js';
import {
  ApiError,
  getComments,
  getLyric,
  getSection,
  getSimilar,
  getAccountProfile,
  getTrackUrl,
  loginQrCheck,
  loginQrCreate,
  loginState,
  logout,
  proxyAudio,
  search,
  sectionsMeta,
  stats,
  warmSections,
} from './netease.js';
import {
  GuardError,
  SECURITY_HEADERS,
  SESSION_TOKEN,
  createRateLimiter,
  createRequestGuard,
} from './security.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const guard = createRequestGuard({
  port: PORT,
  lanIp: EXPOSE_LAN ? LAN_IP : null,
  extraOrigins: EXTRA_ORIGINS,
});

// 敏感接口：改状态、读账号资料、消耗上游登录配额，一律要求会话令牌。
const TOKEN_REQUIRED = new Set([
  '/api/login/qr',
  '/api/login/qr/check',
  '/api/logout',
  '/api/user',
]);

const qrCreateLimiter = createRateLimiter({ limit: 5, windowMs: 60_000, message: '二维码创建过于频繁，请一分钟后再试' });
const qrCheckLimiter = createRateLimiter({ limit: 90, windowMs: 60_000, message: '二维码轮询过于频繁，请稍后再试' });
const writeLimiter = createRateLimiter({ limit: 12, windowMs: 60_000, message: '操作过于频繁，请稍后再试' });

// 只有本进程创建过的二维码 key 才能被轮询，挡住「拿任意 key 反复打上游」。
const qrSessions = new Map();
function rememberQrKey(key) {
  if (!key) return;
  qrSessions.set(String(key), Date.now());
  if (qrSessions.size > 200) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, at] of qrSessions) if (at < cutoff) qrSessions.delete(k);
  }
}

function clientKey(req) {
  return String(req.socket?.remoteAddress || 'unknown');
}

function decodeParam(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new GuardError('BAD_PARAM', '参数编码不合法', 400);
  }
}

function sendJSON(res, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(body);
}

function sendError(res, error) {
  const status = Number(error?.status) || 502;
  const code = error?.code || 'INTERNAL';
  const message = error?.message || '服务异常';
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJSON(res, status, { error: { code, message } });
}

function isAllowedStatic(pathname) {
  return (
    pathname === '/index.html' ||
    pathname === '/manifest.webmanifest' ||
    pathname.startsWith('/src/') ||
    pathname.startsWith('/assets/')
  );
}

async function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/favicon.ico') {
    res.writeHead(204, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  if (!isAllowedStatic(pathname)) {
    sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: '页面不存在' } });
    return;
  }

  const filePath = path.resolve(ROOT, '.' + pathname);
  const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (!filePath.startsWith(rootPrefix)) {
    sendJSON(res, 403, { error: { code: 'FORBIDDEN', message: '禁止访问' } });
    return;
  }
  // 白名单只放行源码与静态资源；即便 /src/ 下出现凭据/数据文件也不外发。
  const ext = path.extname(filePath).toLowerCase();
  if (pathname.startsWith('/src/') && !(ext in MIME)) {
    sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: '资源不存在' } });
    return;
  }
  if (!(ext in MIME)) {
    sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: '资源不存在' } });
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext],
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await pipeline(fs.createReadStream(filePath), res);
  } catch {
    if (!res.headersSent) {
      sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: '资源不存在' } });
    } else {
      res.destroy();
    }
  }
}

function parseTrackParams(url) {
  const level = url.searchParams.get('level') || 'standard';
  if (!LEVELS.includes(level)) {
    throw new GuardError('BAD_LEVEL', '音质参数不合法', 400);
  }
  const feeRaw = url.searchParams.get('fee');
  const fee = feeRaw === null ? 0 : Number(feeRaw);
  if (feeRaw !== null && (!Number.isInteger(fee) || fee < 0 || fee > 16)) {
    throw new GuardError('BAD_FEE', 'fee 参数不合法', 400);
  }
  return { level, fee };
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const started = Date.now();

  try {
    if (TOKEN_REQUIRED.has(pathname)) guard.assertToken(req);

    if (pathname === '/api/session' && req.method === 'GET') {
      sendJSON(res, 200, {
        token: SESSION_TOKEN,
        exposeLan: EXPOSE_LAN,
        lanUrl: EXPOSE_LAN && LAN_IP ? `http://${LAN_IP}:${PORT}` : null,
      });
      return;
    }

    if (pathname === '/api/health') {
      sendJSON(res, 200, {
        ok: true,
        upstream: UPSTREAM,
        envCookie: Boolean(COOKIE),
        login: loginState(),
        cache: stats(),
        uptime: Math.round(process.uptime()),
        exposeLan: EXPOSE_LAN,
      });
      return;
    }

    if (pathname === '/api/sections') {
      sendJSON(res, 200, { sections: sectionsMeta() });
      return;
    }

    let match = pathname.match(/^\/api\/section\/(.+)$/);
    if (match && req.method === 'GET') {
      const key = decodeParam(match[1]);
      if (!/^[\w\u4e00-\u9fa5-]{1,48}$/.test(key)) {
        throw new GuardError('BAD_SECTION', '板块参数不合法', 400);
      }
      sendJSON(res, 200, await getSection(key));
      return;
    }

    if (pathname === '/api/search' && req.method === 'GET') {
      const keyword = url.searchParams.get('q') || '';
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw === null ? 60 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new GuardError('BAD_LIMIT', 'limit 参数不合法', 400);
      }
      // searchParams.get 已经解码过一次，不要二次 decodeURIComponent（会破坏含 % 的关键词）。
      sendJSON(res, 200, await search(keyword, limit));
      return;
    }

    match = pathname.match(/^\/api\/track\/(\d+)\/url$/);
    if (match && req.method === 'GET') {
      const { fee, level } = parseTrackParams(url);
      sendJSON(res, 200, await getTrackUrl(match[1], { fee, level }));
      return;
    }

    match = pathname.match(/^\/api\/track\/(\d+)\/lyric$/);
    if (match && req.method === 'GET') {
      sendJSON(res, 200, await getLyric(match[1]));
      return;
    }

    match = pathname.match(/^\/api\/track\/(\d+)\/comments$/);
    if (match && req.method === 'GET') {
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw === null ? 20 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new GuardError('BAD_LIMIT', 'limit 参数不合法', 400);
      }
      sendJSON(res, 200, await getComments(match[1], limit));
      return;
    }

    match = pathname.match(/^\/api\/track\/(\d+)\/similar$/);
    if (match && req.method === 'GET') {
      sendJSON(res, 200, await getSimilar(match[1]));
      return;
    }

    match = pathname.match(/^\/api\/audio\/(\d+)$/);
    if (match && (req.method === 'GET' || req.method === 'HEAD')) {
      const level = url.searchParams.get('level') || 'standard';
      if (!LEVELS.includes(level)) {
        throw new GuardError('BAD_LEVEL', '音质参数不合法', 400);
      }
      await proxyAudio(match[1], req, res, { level });
      return;
    }

    // —— 扫码登录（仅本机使用，cookie 只存本机文件）——
    if (pathname === '/api/login/status' && req.method === 'GET') {
      sendJSON(res, 200, loginState());
      return;
    }
    if (pathname === '/api/login/qr' && req.method === 'GET') {
      qrCreateLimiter(`${clientKey(req)}:qr:create`);
      const data = await loginQrCreate();
      rememberQrKey(data.key);
      sendJSON(res, 200, data);
      return;
    }
    if (pathname === '/api/login/qr/check' && req.method === 'GET') {
      qrCheckLimiter(`${clientKey(req)}:qr:check`);
      const key = url.searchParams.get('key') || '';
      if (!qrSessions.has(key)) {
        throw new GuardError('BAD_KEY', '二维码会话不存在或已过期，请刷新二维码', 400);
      }
      const data = await loginQrCheck(key);
      if (data?.status === 'success' || data?.status === 'expired') qrSessions.delete(key);
      sendJSON(res, 200, data);
      return;
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      writeLimiter(`${clientKey(req)}:logout`);
      sendJSON(res, 200, await logout());
      return;
    }
    if (pathname === '/api/user' && req.method === 'GET') {
      writeLimiter(`${clientKey(req)}:user`);
      sendJSON(res, 200, await getAccountProfile());
      return;
    }

    sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
  } catch (error) {
    if (error?.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    const known = error instanceof ApiError || error instanceof GuardError;
    console.error(`[api] ${req.method} ${pathname} → ${error.code || error.name}: ${error.message}`);
    // 未知异常不把内部错误串回显给客户端。
    sendError(res, known ? error : new GuardError('INTERNAL', '服务内部错误，请稍后重试', 502));
  } finally {
    if (!pathname.startsWith('/api/audio/')) {
      const ms = Date.now() - started;
      if (ms > 300) console.log(`[api] ${req.method} ${pathname} ${ms}ms`);
    }
  }
}

async function handleRequest(req, res) {
  try {
    guard.assertRequest(req);
  } catch (error) {
    sendJSON(res, error.status || 403, { error: { code: error.code || 'FORBIDDEN', message: error.message } });
    return;
  }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendJSON(res, 400, { error: { code: 'BAD_URL', message: '请求地址不合法' } });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    await handleApi(req, res, url);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJSON(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求方式' } });
    return;
  }

  await serveStatic(req, res, url.pathname);
}

const server = http.createServer(handleRequest);
let lanServer = null;

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请设置 PORT 环境变量换一个端口。`);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  PureTone 已启动：http://${HOST}:${PORT}`);
  console.log(`  上游：${UPSTREAM}`);
  console.log(`  登录态：${COOKIE ? '已配置 NETEASE_COOKIE' : '未配置（匿名模式）'}`);
  console.log(`  缓存：内存 TTL；预热：${WARM ? '开' : '关'}`);
  console.log(`  局域网访问：${EXPOSE_LAN ? '已开启（仅可在可信内网使用）' : '已禁用'}\n`);
  if (WARM) {
    warmSections().catch((error) => console.error('[warm]', error));
  }
});

// 默认只绑回环；小程序真机调试需显式 EXPOSE_LAN=1，避免无鉴权接口默认暴露到局域网。
if (EXPOSE_LAN && LAN_IP && LAN_IP !== HOST) {
  lanServer = http.createServer(handleRequest);
  lanServer.on('error', (error) => {
    console.error(`[lan] ${LAN_IP}:${PORT} 绑定失败（真机预览不可用）：${error.code}`);
  });
  lanServer.listen(PORT, LAN_IP, () => {
    console.log(`  真机预览：http://${LAN_IP}:${PORT}`);
    console.log('  注意：该地址可被同网段任意设备访问，请勿在公共网络使用。\n');
  });
} else if (!EXPOSE_LAN) {
  console.log('  如需小程序真机调试：设置 EXPOSE_LAN=1 后重启服务。\n');
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n正在关闭…');
  const done = () => process.exit(0);
  Promise.all([
    new Promise((resolve) => server.close(resolve)),
    lanServer ? new Promise((resolve) => lanServer.close(resolve)) : Promise.resolve(),
  ]).then(done, done);
  setTimeout(done, 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
