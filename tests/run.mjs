/**
 * PureTone 零依赖测试：node tests/run.mjs（或 npm test）。
 * 只测不依赖 DOM 的纯逻辑模块：服务端缓存、LRC 解析、格式化、音轨标准化。
 * 播放器/队列等 DOM 相关行为由浏览器回归覆盖（见 docs/ARCH.md）。
 */
import assert from 'node:assert/strict';
import process from 'node:process';

let passed = 0;
let failed = 0;
const groups = [];

function group(name, fn) {
  group.current = name;
  return fn();
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    groups.push(`${group.current} › ${name}`);
    console.error(`  ✗ ${group.current} › ${name}`);
    console.error(`    ${error.message.split('\n').slice(0, 4).join('\n    ')}`);
  }
}

// —— format.js ——
const { clamp, formatTime } = await import('../src/core/format.js');

await group('format', async () => {
  await test('formatTime 常规与边界', () => {
    assert.equal(formatTime(0), '0:00');
    assert.equal(formatTime(-3), '0:00');
    assert.equal(formatTime(NaN), '0:00');
    assert.equal(formatTime(59.9), '0:59');
    assert.equal(formatTime(61), '1:01');
    assert.equal(formatTime(3599), '59:59');
  });
  await test('clamp', () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-5, 0, 10), 0);
    assert.equal(clamp(15, 0, 10), 10);
  });
});

// —— lyrics.js ——
const { parseLyrics, findLyricIndex } = await import('../src/core/lyrics.js');

await group('lyrics', async () => {
  await test('解析基础时间标签', () => {
    const lines = parseLyrics('[00:01.000]第一句\n[00:05.50]第二句');
    assert.equal(lines.length, 2);
    assert.equal(lines[0].time, 1);
    assert.equal(lines[0].text, '第一句');
    assert.equal(lines[1].time, 5.5);
  });

  await test('一行多时间标签', () => {
    const lines = parseLyrics('[00:01][00:11]副歌');
    assert.deepEqual(lines.map((l) => l.time), [1, 11]);
    assert.equal(lines[0].text, '副歌');
  });

  await test('翻译按时间戳合并', () => {
    const lrc = '[00:01]hello\n[00:10]world';
    const tlyric = '[00:01.010]你好\n[00:10]世界';
    const lines = parseLyrics(lrc, tlyric);
    assert.equal(lines[0].translation, '你好');
    assert.equal(lines[1].translation, '世界');
  });

  await test('offset 生效且负值截为 0', () => {
    const lines = parseLyrics('[offset:+1000]\n[00:02]甲');
    assert.equal(lines[0].time, 3);
    const neg = parseLyrics('[offset:-9000]\n[00:02]乙');
    assert.equal(neg[0].time, 0);
  });

  await test('过滤空行与署名行', () => {
    const lines = parseLyrics('作曲：某人\n作词：某人\n\n[00:01]正文');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].text, '正文');
  });

  await test('yrc 逐字接口兜底为主要文本源', () => {
    const lines = parseLyrics('', '', '[00:03]逐字歌词');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].time, 3);
  });

  await test('按时间排序', () => {
    const lines = parseLyrics('[00:09]后\n[00:02]前');
    assert.equal(lines[0].text, '前');
    assert.equal(lines[1].text, '后');
  });

  await test('findLyricIndex 边界', () => {
    const lines = parseLyrics('[00:01]a\n[00:05]b\n[00:09]c');
    assert.equal(findLyricIndex(lines, 0.2), -1);
    assert.equal(findLyricIndex(lines, 1.0), 0);
    // 行切换提前 0.12s 抢亮：4.99 已算入下一行（5.0）的显示窗口。
    assert.equal(findLyricIndex(lines, 4.99), 1);
    assert.equal(findLyricIndex(lines, 5.0), 1);
    assert.equal(findLyricIndex(lines, 100), 2);
    assert.equal(findLyricIndex([], 5), -1);
  });
});

// —— server/cache.js ——
const cache = await import('../server/cache.js');

await group('cache', async () => {
  await test('set/get/TTL 过期', async () => {
    cache.set('t:1', 'a', 50);
    assert.equal(cache.get('t:1'), 'a');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(cache.get('t:1'), null);
  });

  await test('wrap 并发同 key 只执行一次 fn', async () => {
    let calls = 0;
    const results = await Promise.all([
      cache.wrap('w:1', 1000, async () => ((calls += 1), 'x')),
      cache.wrap('w:1', 1000, async () => ((calls += 1), 'x')),
      cache.wrap('w:1', 1000, async () => ((calls += 1), 'x')),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(results, ['x', 'x', 'x']);
  });

  await test('wrap 失败不写入缓存，等待方收到同一报错', async () => {
    const err = new Error('boom');
    const waiters = [cache.wrap('bad:1', 1000, () => Promise.reject(err)).catch(() => 'caught')];
    waiters.push(cache.wrap('bad:1', 1000, () => Promise.resolve('late')).catch((e) => `caught:${e.message}`));
    assert.deepEqual((await Promise.all(waiters)).slice(0, 1), ['caught']);
    assert.equal(cache.get('bad:1'), null);
  });

  await test('delete 与 delPrefix', () => {
    cache.set('p:1', 1, 1000);
    cache.set('p:2', 2, 1000);
    cache.set('q:1', 3, 1000);
    cache.delPrefix('p:');
    assert.equal(cache.get('p:1'), null);
    assert.equal(cache.get('q:1'), 3);
    cache.del('q:1');
    assert.equal(cache.get('q:1'), null);
  });

  await test('超上限淘汰且容量封顶', async () => {
    for (let i = 0; i < 300; i += 1) cache.set(`big:${i}`, i, 10000);
    assert.ok(cache.stats().size <= 240, `size=${cache.stats().size}`);
  });

  await test('stats 有读数', () => {
    const s = cache.stats();
    assert.ok(typeof s.size === 'number' && typeof s.hits === 'number');
  });
});

// —— server/netease.js normalizeTrack ——
const { normalizeTrack } = await import('../server/netease.js');

await group('normalizeTrack', async () => {
  await test('标准字段映射', () => {
    const t = normalizeTrack({
      id: 123,
      name: '歌名',
      ar: [{ name: '歌手A' }, { name: '歌手B' }],
      al: { name: '专辑名', picUrl: 'http://example.com/a.jpg' },
      dt: 215000,
      fee: 1,
      mv: 9,
    });
    assert.equal(t.id, '123');
    assert.equal(t.artist, '歌手A / 歌手B');
    assert.equal(t.duration, 215);
    assert.equal(t.vip, true);
    assert.equal(t.paid, false);
    assert.ok(t.cover.startsWith('https://'), '封面应升级 https');
  });

  await test('fee 4 标记为付费、album/variants 字段兼容', () => {
    const t = normalizeTrack({ id: '9', name: 'x', artists: [{ name: 'y' }], album: { name: 'z' }, duration: 60000, privilege: { fee: 4 } });
    assert.equal(t.paid, true);
    assert.equal(t.artist, 'y');
    assert.equal(t.album, 'z');
  });

  await test('非法输入返回 null', () => {
    assert.equal(normalizeTrack(null), null);
    assert.equal(normalizeTrack({}), null);
    assert.equal(normalizeTrack({ id: null, name: 'x' }), null);
  });

  await test('缺省值兜底', () => {
    const t = normalizeTrack({ id: 5 });
    assert.equal(t.name, '未知歌曲');
    assert.equal(t.artist, '未知歌手');
    assert.equal(t.album, '未知专辑');
    assert.equal(t.cover, '/assets/cover.svg');
    assert.equal(t.vip, false);
  });
});

// 汇总
console.log(`\n测试结果：${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
if (failed) {
  console.log(`失败分组：\n  - ${groups.join('\n  - ')}`);
  process.exitCode = 1;
}
