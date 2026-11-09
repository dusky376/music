/**
 * 安全层 / HTTP 层黑盒测试：node tests/security.mjs（由 npm test 串联调用）。
 * 分两部分：
 *   1) 直接 import server/security.js 做纯函数单测（不依赖网络）。
 *   2) 用独立端口 8791 起 server/index.js 子进程，按接口契约做黑盒断言。
 * 严格按契约写断言；后端未完成导致的失败如实记录，不放宽断言、不改 server。
 * 不依赖真实外网/真实网易云接口：上游固定为本地不可达的 127.0.0.1:3000。
 * 每项打印 [PASS]/[FAIL] + 描述，结束打印总数，失败以非 0 退出。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import process from 'node:process';
import {
  assertSafeAudioUrl,
  isAllowedAudioHost,
  fetchGuardedAudio,
  GuardError,
  SECURITY_HEADERS,
  SESSION_TOKEN,
  createRequestGuard,
  createRateLimiter,
} from '../server/security.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8791;
const UPSTREAM = 'http://127.0.0.1:3000';
// 关键隔离：子进程读写凭据必须用临时目录，否则 /api/logout 的黑盒断言会删除用户真实的
// server/.login-cookie，或写下 .logged-out 标记导致真实登录态在重启后失效。
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'puretone-test-'));

let passed = 0;
let failed = 0;
const failures = [];

function section(name) {
  console.log('\n-- ' + name + ' --');
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('[PASS] ' + name);
  } catch (error) {
    failed += 1;
    failures.push(name);
    console.error('[FAIL] ' + name);
    const msg = (error && error.message) ? error.message : String(error);
    console.error('       ' + msg.split('\n').slice(0, 4).join('\n       '));
  }
}

// -- 请求辅助：用 node:http 精确控制 Host / Origin / 畸形路径等头部 --
function request(pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: pathname,
        method,
        headers: { Host: '127.0.0.1:' + PORT, ...headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch { /* 非 JSON 响应 */ }
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        });
      },
    );
    req.setTimeout(3500, () => req.destroy(new Error('请求超时（3.5s）')));
    req.on('error', reject);
    req.end();
  });
}

// -- 子进程生命周期 --
let child = null;
let serverLog = '';

function startServer() {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      WARM: '0',
      NETEASE_API: UPSTREAM,
      EXPOSE_LAN: '0',
      PURETONE_STATE_DIR: STATE_DIR,
      // 清掉可能继承来的真实配置，保证断言环境干净。
      NETEASE_COOKIE: '',
      NETEASE_COOKIE_QUERY: '',
      ALLOWED_ORIGINS: '',
      AUDIO_HOSTS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk) => { serverLog += chunk.toString('utf8'); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
}

async function waitReady() {
  const start = Date.now();
  while (Date.now() - start < 12000) {
    if (child.exitCode !== null) {
      throw new Error('服务进程提前退出 code=' + child.exitCode + '\n' + serverLog);
    }
    if (serverLog.includes('已启动')) return; // 契约：启动日志含「已启动」
    // 兜底：HTTP 探测能连通即视为就绪（绕开日志编码差异）
    const ok = await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: PORT, path: '/api/health', method: 'GET', timeout: 700 },
        (res) => { res.resume(); resolve(true); },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('等待服务启动超时（12s）\n' + serverLog);
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const waitExit = (ms) => Promise.race([
    new Promise((r) => child.once('exit', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), ms)),
  ]);
  child.kill('SIGTERM');
  if (!(await waitExit(3000))) {
    child.kill('SIGKILL');
    await waitExit(2000);
  }
}

// ============ 第一部分：server/security.js 纯函数单测 ============
section('security.js / assertSafeAudioUrl');
await test('拒绝 http://127.0.0.1:3000/（回环）', () => {
  assert.throws(() => assertSafeAudioUrl('http://127.0.0.1:3000/'), GuardError);
});
await test('拒绝 http://169.254.169.254/latest/meta-data/（云元数据）', () => {
  assert.throws(() => assertSafeAudioUrl('http://169.254.169.254/latest/meta-data/'), GuardError);
});
await test('拒绝 https://evil.example.com/a.mp3（非白名单域名）', () => {
  assert.throws(() => assertSafeAudioUrl('https://evil.example.com/a.mp3'), GuardError);
});
await test('拒绝 file:///etc/passwd（非 http/https 协议）', () => {
  assert.throws(() => assertSafeAudioUrl('file:///etc/passwd'), GuardError);
});
await test('接受 https://m801.music.126.net/a.mp3', () => {
  assert.equal(assertSafeAudioUrl('https://m801.music.126.net/a.mp3'), 'https://m801.music.126.net/a.mp3');
});
await test('http://music.163.com/... 升级为 https', () => {
  const out = assertSafeAudioUrl('http://music.163.com/song/media/outer/url?id=1');
  assert.ok(out.startsWith('https://'), '实际：' + out);
});

section('security.js / isAllowedAudioHost');
await test('私网 / 回环 / 元数据主机一律 false', () => {
  for (const h of ['127.0.0.1', '192.168.1.10', '10.0.0.1', '169.254.169.254', '::1', 'localhost']) {
    assert.equal(isAllowedAudioHost(h), false, '应拒绝 ' + h);
  }
});
await test('音频 CDN 白名单域名 true', () => {
  assert.equal(isAllowedAudioHost('m801.music.126.net'), true);
  assert.equal(isAllowedAudioHost('music.163.com'), true);
});

section('security.js / 契约导出');
await test('SECURITY_HEADERS 含 nosniff 与 CSP', () => {
  assert.equal(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.ok(SECURITY_HEADERS['Content-Security-Policy']);
});
await test('SESSION_TOKEN 非空，createRequestGuard/createRateLimiter 为函数', () => {
  assert.ok(typeof SESSION_TOKEN === 'string' && SESSION_TOKEN.length > 0);
  assert.equal(typeof createRequestGuard, 'function');
  assert.equal(typeof createRateLimiter, 'function');
});

section('security.js / createRequestGuard');
const guard = createRequestGuard({ port: PORT });
await test('合法本机 Host 放行', () => {
  assert.doesNotThrow(() => guard.assertRequest({ headers: { host: '127.0.0.1:' + PORT } }));
});
await test('伪造 Host 抛 BAD_HOST', () => {
  assert.throws(() => guard.assertRequest({ headers: { host: 'evil.example.com' } }));
});
await test('跨站 Origin 抛 BAD_ORIGIN', () => {
  assert.throws(() => guard.assertRequest({ headers: { host: '127.0.0.1:' + PORT, origin: 'https://evil.example.com' } }));
});
await test('Sec-Fetch-Site: cross-site 抛 CROSS_SITE', () => {
  assert.throws(() => guard.assertRequest({ headers: { host: '127.0.0.1:' + PORT, 'sec-fetch-site': 'cross-site' } }));
});
await test('缺 token 被拒，正确 token 放行', () => {
  assert.throws(() => guard.assertToken({ headers: {} }));
  assert.doesNotThrow(() => guard.assertToken({ headers: { 'x-puretone-token': SESSION_TOKEN } }));
});

section('security.js / createRateLimiter');
await test('窗口内超过上限抛 RATE_LIMITED', () => {
  // createRateLimiter 直接返回 check(key) 函数，不是 { check } 对象。
  const check = createRateLimiter({ limit: 2, windowMs: 10000 });
  check('qr:127.0.0.1');
  check('qr:127.0.0.1');
  assert.throws(() => check('qr:127.0.0.1'), (e) => e instanceof GuardError && e.code === 'RATE_LIMITED');
});

section('security.js / fetchGuardedAudio（响应头到手后清除定时器）');
await test('mock 上游：拿到响应头后 AbortController 不再被超时 abort', async () => {
  // 说明：本地假上游无法用于真实 fetch，因为 assertSafeAudioUrl 会拒绝 IP / 回环主机名。
  // 故改为 mock 全局 fetch 的短时实验：用极小 headerTimeout(40ms)，若定时器未清除，
  // 等待 120ms 后 controller.signal 会被 abort；清除则保持未 abort，长音频流不被切断。
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      status: 200,
      headers: { get: () => null },
      body: null,
    });
    const { controller } = await fetchGuardedAudio(
      'https://m801.music.126.net/a.mp3',
      {},
      { headerTimeout: 40 },
    );
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(controller.signal.aborted, false, '响应头到手后定时器应被清除，长音频流不应被硬超时 abort');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ============ 第二部分：HTTP 黑盒集成测试（独立端口 8791） ============
section('HTTP 黑盒（server/index.js 子进程，PORT=8791）');
let sessionToken = null;
try {
  startServer();
  await waitReady();

  await test('GET /api/health 200，含 envCookie/login/exposeLan，不含旧 cookie 字段', async () => {
    const r = await request('/api/health');
    assert.equal(r.status, 200, '实际 status=' + r.status + ' body=' + r.body.slice(0, 160));
    assert.ok(r.json, '响应应为 JSON');
    assert.equal(r.json.ok, true, 'ok 应为 true');
    assert.ok('envCookie' in r.json, '应含 envCookie');
    assert.ok('login' in r.json, '应含 login');
    assert.ok('exposeLan' in r.json, '应含 exposeLan');
    assert.ok(!('cookie' in r.json), '不应含旧的 cookie 字段');
  });

  await test('GET /api/session 200 且返回非空 token', async () => {
    const r = await request('/api/session');
    assert.equal(r.status, 200, '实际 status=' + r.status + ' body=' + r.body.slice(0, 160));
    assert.ok(r.json && typeof r.json.token === 'string' && r.json.token.length > 0, '应含非空 token');
    sessionToken = r.json.token;
  });

  await test('伪造 Host: evil.example.com -> 403', async () => {
    const r = await request('/api/health', { headers: { Host: 'evil.example.com' } });
    assert.equal(r.status, 403, '实际 status=' + r.status);
  });

  await test('Origin: https://evil.example.com -> 403', async () => {
    const r = await request('/api/health', { headers: { Origin: 'https://evil.example.com' } });
    assert.equal(r.status, 403, '实际 status=' + r.status);
  });

  await test('Sec-Fetch-Site: cross-site -> 403', async () => {
    const r = await request('/api/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(r.status, 403, '实际 status=' + r.status);
  });

  await test('POST /api/logout 无 X-PureTone-Token -> 403', async () => {
    const r = await request('/api/logout', { method: 'POST' });
    assert.equal(r.status, 403, '实际 status=' + r.status);
  });

  await test('带正确 token 后 /api/logout 不再因 CSRF 被拒（不要求 200）', async () => {
    assert.ok(sessionToken, '前置：/api/session 应返回 token');
    const r = await request('/api/logout', { method: 'POST', headers: { 'X-PureTone-Token': sessionToken } });
    assert.notEqual(r.status, 403, '带 token 不应再被 CSRF 拒绝，实际 status=' + r.status);
  });

  await test('GET /api/track/1/url?level=../../etc -> 400 BAD_LEVEL', async () => {
    const r = await request('/api/track/1/url?level=../../etc');
    assert.equal(r.status, 400, '实际 status=' + r.status + ' body=' + r.body.slice(0, 160));
    assert.equal(r.json && r.json.error && r.json.error.code, 'BAD_LEVEL', '应返回 BAD_LEVEL');
  });

  await test('GET /api/track/1/url?fee=abc -> 400 BAD_FEE', async () => {
    const r = await request('/api/track/1/url?fee=abc');
    assert.equal(r.status, 400, '实际 status=' + r.status + ' body=' + r.body.slice(0, 160));
    assert.equal(r.json && r.json.error && r.json.error.code, 'BAD_FEE', '应返回 BAD_FEE');
  });

  await test('GET /api/section/%E0%A4%A（畸形 URI）-> 400 BAD_PARAM，不外泄内部错误串', async () => {
    const r = await request('/api/section/%E0%A4%A');
    assert.equal(r.status, 400, '不应是 502，实际 status=' + r.status);
    assert.equal(r.json && r.json.error && r.json.error.code, 'BAD_PARAM', '应返回 BAD_PARAM');
    assert.ok(!r.body.includes('URI malformed'), '不应外泄 URI malformed');
    assert.ok(!r.body.toLowerCase().includes('decodeuricomponent'), '不应外泄内部错误串');
  });

  await test('静态白名单：/server/config.js -> 404（不泄露源码）', async () => {
    const r = await request('/server/config.js');
    assert.equal(r.status, 404, '实际 status=' + r.status);
  });

  await test('静态白名单：/server/.login-cookie -> 404（不泄露凭据）', async () => {
    const r = await request('/server/.login-cookie');
    assert.equal(r.status, 404, '实际 status=' + r.status);
    assert.ok(!r.body.includes('MUSIC_U'), '不应泄露凭据内容');
  });

  await test('路径穿越 /server/../server/config.js -> 非 200', async () => {
    const r = await request('/server/../server/config.js');
    assert.notEqual(r.status, 200, '实际 status=' + r.status);
  });

  await test('编码穿越 /%2e%2e/server/config.js -> 非 200', async () => {
    const r = await request('/%2e%2e/server/config.js');
    assert.notEqual(r.status, 200, '实际 status=' + r.status);
  });

  await test('所有响应带 X-Content-Type-Options / CSP 安全头', async () => {
    for (const p of ['/api/health', '/index.html', '/server/config.js']) {
      const r = await request(p);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', p + ' 缺 nosniff');
      assert.ok(r.headers['content-security-policy'], p + ' 缺 CSP');
    }
  });

  await test('GET /api/login/qr 无 token 连续请求 -> 403（CSRF），不刷上游', async () => {
    // 契约实现会在进入业务逻辑前以 CSRF 拒绝，从而不触达上游；
    // 后端未完成时这里可能尝试连本地不可达上游（非真实外网），计入 FAIL。
    for (let i = 0; i < 3; i += 1) {
      const r = await request('/api/login/qr');
      assert.equal(r.status, 403, '第 ' + (i + 1) + ' 次应被 CSRF 拒绝，实际 status=' + r.status);
    }
  });
} catch (error) {
  failed += 1;
  failures.push('服务启动 / 就绪');
  console.error('[FAIL] 服务启动 / 就绪');
  const msg = (error && error.message) ? error.message : String(error);
  console.error('       ' + msg.split('\n').slice(0, 6).join('\n       '));
} finally {
  await stopServer();
  try {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
  } catch {
    // 临时目录清理失败不影响测试结论。
  }
}

// ============ 汇总 ============
console.log('\n测试结果：' + (passed + failed) + ' 项，通过 ' + passed + '，失败 ' + failed);
if (failures.length) {
  console.error('失败项：\n  - ' + failures.join('\n  - '));
}
if (failed) process.exitCode = 1;
