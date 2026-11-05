const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const OFFSET_TAG = /\[offset\s*:\s*([+-]?\d+)\]/i;
const CREDIT = /^(作词|作曲|编曲|制作人|出品|监制|混音|母带|录音|和声|吉他|贝斯|鼓|键盘|弦乐|发行|词|曲)\s*[:：]/;

function readOffset(raw) {
  const match = String(raw || '').match(OFFSET_TAG);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value / 1000 : 0;
}

function parseTimeTags(line) {
  const times = [];
  let match;
  TIME_TAG.lastIndex = 0;
  while ((match = TIME_TAG.exec(line))) {
    const minutes = Number(match[1]) || 0;
    const seconds = Number(match[2]) || 0;
    const fractionText = match[3] || '0';
    const fraction = Number(fractionText.padEnd(3, '0').slice(0, 3)) / 1000;
    times.push(minutes * 60 + seconds + fraction);
  }
  return times;
}

function parseRaw(raw, offset) {
  if (!raw) return [];
  const result = [];
  for (const rawLine of String(raw).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const times = parseTimeTags(line);
    if (!times.length) continue;
    const text = line.replace(TIME_TAG, '').trim();
    if (!text || CREDIT.test(text)) continue;
    for (const time of times) {
      result.push({ time: Math.max(0, time + offset), text });
    }
  }
  return result.sort((a, b) => a.time - b.time);
}

/**
 * 解析 LRC，并把翻译按时间戳合并到原文行。
 * 支持一行多个时间戳、毫秒/百分秒、[offset:] 与 tlyric。
 */
export function parseLyrics(lrc, tlyric = '', yrc = '') {
  const offset = readOffset(lrc) || readOffset(tlyric);
  const lines = parseRaw(lrc || yrc, offset);
  const translations = parseRaw(tlyric, offset);
  if (translations.length) {
    let cursor = 0;
    for (const line of lines) {
      while (cursor + 1 < translations.length && translations[cursor + 1].time <= line.time + 0.08) {
        cursor += 1;
      }
      const best = translations[cursor];
      if (best && Math.abs(best.time - line.time) <= 0.5) line.translation = best.text;
    }
  }
  return lines;
}

export function findLyricIndex(lines, time) {
  if (!Array.isArray(lines) || !lines.length) return -1;
  const current = Number(time) || 0;
  if (current < lines[0].time) return -1;
  let low = 0;
  let high = lines.length - 1;
  let answer = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].time <= current + 0.12) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return answer;
}
