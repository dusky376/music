/**
 * 供 start-server.bat 调用的一次性健康检查解析（Windows 无 jq，改用已安装的 Node）。
 * 用法：node scripts/healthcheck.mjs <health.json> <expected-upstream>
 * 退出码：
 *   0  健康（ok===true）且 upstream 与期望一致（或响应未报告 upstream）
 *   2  响应不是合法 JSON，或 ok !== true
 *   3  upstream 与期望不一致（疑似「环境变量丢失静默回退公共代理」）
 */
import fs from 'node:fs';
import process from 'node:process';

const [file, expected] = process.argv.slice(2);

let data;
try {
  data = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  console.error('  [健康检查] 无法解析 /api/health 响应：' + error.message);
  process.exit(2);
}

if (data.ok !== true) {
  console.error('  [健康检查] 响应缺少 "ok":true（HTTP 200 但内容异常）');
  process.exit(2);
}

const normalize = (s) => String(s || '').trim().replace(/\/+$/, '').toLowerCase();
const actual = normalize(data.upstream);
const want = normalize(expected);

if (want && actual && actual !== want) {
  console.error('  [健康检查] upstream 不一致！');
  console.error('    期望（NETEASE_API）: ' + want);
  console.error('    实际（health）     : ' + actual);
  console.error('    该进程可能丢失 NETEASE_API，已静默回退到公共代理。');
  process.exit(3);
}

console.log('  [健康检查] 通过（ok:true，upstream=' + (actual || '未报告') + '）');
process.exit(0);
