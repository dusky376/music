import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { COOKIE, HOST, PORT, ROOT, WARM } from './config.js';
import {
  ApiError,
  getComments,
  getLyric,
  getSection,
  getSimilar,
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

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' https: data:; media-src 'self' https: http:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'",
};

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

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
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

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const started = Date.now();

  try {
    if (pathname === '/api/health') {
      sendJSON(res, 200, {
        ok: true,
        upstream: 'https://apis.netstart.cn/music',
        cookie: Boolean(COOKIE),
        login: loginState(),
        cache: stats(),
        uptime: Math.round(process.uptime()),
      });
      return;
    }

    if (pathname === '/api/sections') {
      sendJSON(res, 200, { sections: sectionsMeta() });
      return;
    }

    let match = pathname.match(/^\/api\/section\/(.+)$/);
    if (match && req.method === 'GET') {
      const data = await getSection(decodeURIComponent(match[1]));
      sendJSON(res, 200, data);
      return;
    }

    if (pathname === '/api/search' && req.method === 'GET') {
      const keyword = url.searchParams.get('q') || '';
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 60));
      sendJSON(res, 200, await search(keyword, limit));
      return;
    }

    match = pathname.match(/^\/api\/track\/(\d+)\/url$/);
    if (match && req.method === 'GET') {
      const fee = Number(url.searchParams.get('fee')) || 0;
      const level = url.searchParams.get('level') || 'standard';
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
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
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
      await proxyAudio(match[1], req, res);
      return;
    }

    // —— 扫码登录（仅本机使用，cookie 只存内存 + 本地文件）——
    if (pathname === '/api/login/status' && req.method === 'GET') {
      sendJSON(res, 200, loginState());
      return;
    }
    if (pathname === '/api/login/qr' && req.method === 'GET') {
      sendJSON(res, 200, await loginQrCreate());
      return;
    }
    if (pathname === '/api/login/qr/check' && req.method === 'GET') {
      const key = url.searchParams.get('key') || '';
      sendJSON(res, 200, await loginQrCheck(key));
      return;
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      sendJSON(res, 200, logout());
      return;
    }

    sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
  } catch (error) {
    if (error?.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    console.error(`[api] ${req.method} ${pathname} → ${error.code || error.name}: ${error.message}`);
    sendError(res, error);
  } finally {
    if (!pathname.startsWith('/api/audio/')) {
      const ms = Date.now() - started;
      if (ms > 300) console.log(`[api] ${req.method} ${pathname} ${ms}ms`);
    }
  }
}

const server = http.createServer(async (req, res) => {
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
});

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
  console.log(`  上游：https://apis.netstart.cn/music`);
  console.log(`  登录态：${COOKIE ? '已配置 NETEASE_COOKIE' : '未配置（匿名模式）'}`);
  console.log(`  缓存：内存 TTL；预热：${WARM ? '开' : '关'}\n`);
  if (WARM) {
    warmSections().catch((error) => console.error('[warm]', error));
  }
});

function shutdown() {
  console.log('\n正在关闭…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
