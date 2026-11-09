import crypto from 'node:crypto';
import net from 'node:net';

/**
 * 服务端安全策略集中地。
 * 只在本机回环（或显式开启的局域网 IP）上提供服务，但「绑定地址」不等于「鉴权」：
 * DNS rebinding、同网段设备、本机其它进程都能构造任意 Host/Header，所以这里再补三层：
 *   1) Host 白名单        —— 挡住 DNS rebinding 与伪造域名
 *   2) Origin / Fetch-Site —— 挡住普通跨站页面
 *   3) 会话 token          —— 挡住 <img>/<form> 之类无需读响应、也能触发写接口的简单请求
 */

export const SESSION_TOKEN = crypto.randomBytes(24).toString('hex');

export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' https: data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
});

export class GuardError extends Error {
  constructor(code, message, status = 403) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
    this.status = status;
  }
}

function hostnameFromHostHeader(raw = '') {
  const value = String(raw).trim().toLowerCase();
  if (!value) return '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : '';
  }
  const colon = value.lastIndexOf(':');
  if (colon > -1 && /^\d+$/.test(value.slice(colon + 1))) return value.slice(0, colon);
  return value;
}

export function createRequestGuard({ port, lanIp = null, extraOrigins = [] } = {}) {
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);
  if (lanIp) allowedHosts.add(String(lanIp).toLowerCase());

  const allowedOrigins = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ]);
  if (lanIp) allowedOrigins.add(`http://${lanIp}:${port}`);
  for (const origin of extraOrigins) {
    if (origin) allowedOrigins.add(String(origin).replace(/\/+$/, '').toLowerCase());
  }

  return {
    allowedOrigins,

    /** 所有请求（含静态文件）都要过：Host + Origin + Fetch-Site。 */
    assertRequest(req) {
      const host = hostnameFromHostHeader(req.headers.host);
      if (!host || !allowedHosts.has(host)) {
        throw new GuardError('BAD_HOST', '请求来源不被允许', 403);
      }
      const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
      if (site === 'cross-site') {
        throw new GuardError('CROSS_SITE', '拒绝跨站请求', 403);
      }
      const origin = String(req.headers.origin || '').toLowerCase().replace(/\/+$/, '');
      if (origin && !allowedOrigins.has(origin)) {
        throw new GuardError('BAD_ORIGIN', '请求来源不被允许', 403);
      }
    },

    /** 写接口 / 凭据接口额外要求会话 token。 */
    assertToken(req) {
      if (req.headers['x-puretone-token'] !== SESSION_TOKEN) {
        throw new GuardError('CSRF_REJECTED', '缺少或错误的会话令牌，请刷新页面', 403);
      }
    },
  };
}

// —— 上游音频 URL 白名单（SSRF 防护）——
const AUDIO_HOST_SUFFIXES = [
  'music.163.com',
  'music.126.net',
  '126.net',
  '163.com',
  'netease.com',
  'ydmusic.com',
];
for (const extra of String(process.env.AUDIO_HOSTS || '').split(',')) {
  const host = extra.trim().toLowerCase();
  if (host) AUDIO_HOST_SUFFIXES.push(host);
}

export function isAllowedAudioHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  // IP 字面量（含回环、私网、云元数据 169.254.169.254）一律拒绝。
  if (net.isIP(host)) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  return AUDIO_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** 只接受 https 且位于音频 CDN 白名单内的绝对 URL；顺手把明文 http 升级。 */
export function assertSafeAudioUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || ''));
  } catch {
    throw new GuardError('UNSAFE_AUDIO_URL', '音源地址不合法', 502);
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new GuardError('UNSAFE_AUDIO_URL', '音源协议不被允许', 502);
  }
  if (parsed.username || parsed.password) {
    throw new GuardError('UNSAFE_AUDIO_URL', '音源地址不合法', 502);
  }
  if (!isAllowedAudioHost(parsed.hostname)) {
    throw new GuardError('UNSAFE_AUDIO_URL', '音源主机不在白名单内', 502);
  }
  parsed.protocol = 'https:';
  return parsed.toString();
}

/**
 * 手动跟随 302：每一跳都重新校验目标，避免上游/中间人把请求引到内网。
 * 超时只覆盖「连接 + 等到响应头」，拿到响应头后清除定时器，长音频流不会被切断。
 * 返回 controller，调用方可在客户端断开时 abort 上游。
 */
export async function fetchGuardedAudio(url, init = {}, { headerTimeout = 12000, maxRedirects = 5 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), headerTimeout);
  let current = assertSafeAudioUrl(url);
  let hops = 0;
  try {
    for (;;) {
      const response = await fetch(current, { ...init, redirect: 'manual', signal: controller.signal });
      const status = response.status;
      if (status >= 300 && status < 400 && response.headers.get('location')) {
        await response.body?.cancel().catch(() => {});
        if (++hops > maxRedirects) {
          throw new GuardError('TOO_MANY_REDIRECTS', '音源跳转次数过多', 502);
        }
        const location = new URL(response.headers.get('location'), current).toString();
        current = assertSafeAudioUrl(location);
        continue;
      }
      clearTimeout(timer);
      return { response, finalUrl: current, controller };
    }
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof GuardError) throw error;
    if (error?.name === 'AbortError') {
      throw new GuardError('AUDIO_HEADER_TIMEOUT', '音源连接超时', 504);
    }
    throw new GuardError('AUDIO_NETWORK', '无法连接音源', 502);
  }
}

/** 轻量滑动窗口限流，key 通常是 IP + 接口名。 */
export function createRateLimiter({ limit, windowMs, message = '请求过于频繁，请稍后再试' }) {
  const buckets = new Map();
  return function check(key) {
    const now = Date.now();
    const entry = buckets.get(key);
    if (!entry || now - entry.start >= windowMs) {
      buckets.set(key, { start: now, count: 1 });
    } else {
      entry.count += 1;
      if (entry.count > limit) {
        throw new GuardError('RATE_LIMITED', message, 429);
      }
    }
    // 防止长期运行下 Map 无限增长。
    if (buckets.size > 512) {
      for (const [k, v] of buckets) {
        if (now - v.start >= windowMs) buckets.delete(k);
      }
    }
  };
}
