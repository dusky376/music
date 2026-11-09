/**
 * 质量门禁：递归对项目里的 .js / .mjs 做 node --check 语法检查。
 * 排除 netease-api/、node_modules/、.git/、.workbuddy/（第三方与工具目录）。
 * 任何文件失败即打印具体文件并以非 0 退出。
 * 用法：node scripts/check.mjs（由 npm run check 调用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE_DIRS = new Set(['netease-api', 'node_modules', '.git', '.workbuddy']);
const EXTS = new Set(['.js', '.mjs']);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile() && EXTS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
}

const files = [];
walk(ROOT, files);
files.sort();

const failures = [];
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    failures.push(rel);
    console.error('[FAIL] ' + rel);
    const detail = (result.error ? result.error.message : result.stderr || '').trim();
    if (detail) console.error('       ' + detail.split('\n').slice(0, 4).join('\n       '));
  } else {
    console.log('[PASS] ' + rel);
  }
}

console.log('\n语法检查：' + files.length + ' 个文件，通过 ' + (files.length - failures.length) + '，失败 ' + failures.length);
if (failures.length) {
  console.error('失败文件：\n  - ' + failures.join('\n  - '));
  process.exitCode = 1;
}
