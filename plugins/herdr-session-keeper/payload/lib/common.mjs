// 세션키퍼 공용 도구: 파일 읽기, 문자열 처리. (여기는 어떤 AI 종류에도 속하지 않는 순수 도구만 둔다)
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// 파일 앞/뒤 일부만 읽는다 (대화 기록이 수 MB 라 통째로 읽지 않는다)
export function readChunk(file, size, fromEnd) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const len = statSync(file).size;
    const n = Math.min(size, len);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, fromEnd ? len - n : 0);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* 이미 닫힘 */ } }
}

export const unescapeJson = (s) => { try { return JSON.parse('"' + s + '"'); } catch { return s; } };

export function lastMatch(text, re) {
  let m, last = null;
  while ((m = re.exec(text))) last = m[1];
  return last === null ? null : unescapeJson(last);
}

export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Windows 확장 경로 접두어(\\?\C:\...)를 떼고 보통 경로로
export const stripExtendedPrefix = (p) => String(p || '').replace(/^\\\\\?\\/, '');

export const oneLine = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

// 사람이 읽는 시각 "MM-DD HH:MM"
export function fmtTime(ms) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
