// Claude Code 세션 수집: 실행 중 세션 파일 + 대화 기록(jsonl) 에서 ID·제목·폴더·모델을 읽는다. (읽기 전용)
import { readdirSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { UUID, readJson, pidAlive, readChunk, unescapeJson, lastMatch, cap } from './common.mjs';

// Claude Code 설정 폴더: CLAUDE_CONFIG_DIR 이 있으면 그것, 없으면 %APPDATA%\claude-code(이 PC 의 기존 위치)가 있을 때 그것, 아니면 ~\.claude(기본값).
const APPDATA = () => process.env.APPDATA || '';
const configDir = () => {
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  const legacy = join(APPDATA(), 'claude-code');
  if (APPDATA() && existsSync(legacy)) return legacy;
  return join(process.env.USERPROFILE || homedir(), '.claude');
};
export const sessDir = () => join(configDir(), 'sessions');
export const projDir = () => join(configDir(), 'projects');
const MIN_BYTES = 20 * 1024;           // 이보다 작은 기록은 훅/자동 호출이 남긴 껍데기로 보고 기본 숨김
const MODEL_RE = /"model":"(claude-[a-z0-9-]+)"/g;
const AUTO_RE = /^(Analyze this conversation and determine|Below is a conversation log from a Claud)/i;
// 성능: remember 플러그인이 임시 작업 폴더마다 기록 폴더를 하나씩 만들어 수천 개가 쌓이고(실측 2,649개 중 2,562개, 안의 기록은 61개뿐),
// double-shot-latte 자동 도우미는 한 폴더에 2,279개(계속 증가)를 남긴다. 둘 다 기본 목록에서 숨겨지므로 폴더째 읽지 않는다.
const HELPER_DIR = /AppData-Local-Temp-remember-|-claude-double-shot-latte$/;

// 모델 ID(claude-sonnet-5-5) -> 사람이 읽는 이름(Sonnet 5.5)
export function friendlyModel(id) {
  if (!id) return '';
  let m = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?=-|$)/.exec(id);
  if (m) return `${cap(m[1])} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
  m = /^claude-(\d)(?:-(\d))?-([a-z]+)/.exec(id);                 // 옛 형식: claude-3-5-sonnet
  if (m) return `${cap(m[3])} ${m[1]}${m[2] ? '.' + m[2] : ''}`;
  return id.replace(/^claude-/, '');
}

// 세션이 시작된 폴더를 찾는다. claude --resume 은 "시작 폴더"의 기록만 찾으므로 정확해야 한다.
// 기록 파일이 들어 있는 폴더 이름은 시작 폴더의 영문·숫자 아닌 글자를 '-'로 바꾼 것이라, 그 규칙과 일치하는 경로를 우선한다.
export const encodeProj = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

function scanWholeFile(full, scan, seen) {
  let fd;
  try {
    fd = openSync(full, 'r');
    const len = Math.min(statSync(full).size, 16 * 1024 * 1024), step = 1024 * 1024, overlap = 4096;
    const buf = Buffer.alloc(step + overlap);
    for (let pos = 0; pos < len && seen.size === 0; pos += step) {
      const n = readSync(fd, buf, 0, step + overlap, pos);
      if (n <= 0) break;
      scan(buf.toString('utf8', 0, n));
    }
  } catch { /* 읽기 실패는 폴더 못 찾음으로 처리 */ } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* 이미 닫힘 */ } }
}

export function findCwd(full, projName, fallback) {
  const re = /"cwd":"((?:[^"\\]|\\.)*)"/g;
  const seen = new Set();
  const scan = (text) => { re.lastIndex = 0; let m; while ((m = re.exec(text))) seen.add(unescapeJson(m[1])); };
  const pick = () => [...seen].find((c) => encodeProj(c) === projName);
  scan(readChunk(full, 64 * 1024, false));
  let hit = pick(); if (hit) return hit;
  scan(readChunk(full, 256 * 1024, true));
  hit = pick(); if (hit) return hit;
  if (seen.size === 0) {                                   // 앞·뒤에 없으면 파일 전체를 1MB씩 훑는다 (최대 16MB)
    scanWholeFile(full, scan, seen);
    hit = pick(); if (hit) return hit;
  }
  return [...seen][0] || fallback || '';
}

// 지금 실행 중인 Claude 프로세스: sid -> {pid, cwd, entrypoint}
export function liveSessions() {
  const live = new Map();
  let files = [];
  try { files = readdirSync(sessDir()).filter((f) => f.endsWith('.json')); } catch { /* 폴더 없음 */ }
  for (const f of files) {
    const o = readJson(join(sessDir(), f));
    if (o && o.sessionId && o.pid && pidAlive(Number(o.pid))) live.set(o.sessionId, { pid: Number(o.pid), cwd: o.cwd || '', entrypoint: o.entrypoint || '' });
  }
  return live;
}

// session-keeper(자동 복원)가 60초마다 적어 두는 "창 주소 / 창 이름 -> 세션ID" (정확한 연결이 안 될 때의 보조 정보)
export function herdrMap(mapFile) {
  const bySid = new Map();
  const m = readJson(mapFile) || {};
  for (const e of Object.values(m)) if (e && e.sid) bySid.set(e.sid, { addr: e.addr, where: e.where, seen: e.seen, cwd: e.cwd || '' });
  return bySid;
}

function listCandidates({ live, map, cutoff, all }) {
  const cands = [];
  let projects = [];
  try { projects = readdirSync(projDir(), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { /* 폴더 없음 */ }
  const mustDirs = new Set([...live.values(), ...map.values()].map((x) => x.cwd).filter(Boolean).map(encodeProj));
  for (const p of projects) {
    if (!all && HELPER_DIR.test(p.name) && !mustDirs.has(p.name)) continue;
    let files = [];
    try { files = readdirSync(join(projDir(), p.name)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const sid = f.slice(0, -6);
      if (!UUID.test(sid)) continue;
      const full = join(projDir(), p.name, f);
      let st; try { st = statSync(full); } catch { continue; }
      const keep = live.has(sid) || map.has(sid);              // 실행 중이거나 Herdr 창에 연결됐던 세션은 항상 포함
      if (!keep && (st.mtimeMs < cutoff || (!all && st.size < MIN_BYTES))) continue;
      cands.push({ sid, full, proj: p.name, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return cands.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// 한 후보를 행으로 만든다. 숨겨야 하면 null. (싼 판정부터 해서 일찍 끝낸다: 숨길 기록이 수백 개라서)
function buildRow(c, { lv, hm, all }) {
  // 실행 중인 세션은 종류로 판단한다: 자동 도우미(entrypoint sdk-cli)는 숨기고(파일도 안 읽음), 사용자가 연 세션은 실행 중이면 절대 숨기지 않는다.
  if (lv && lv.entrypoint === 'sdk-cli' && !all && !hm) return null;
  const hide = !all && !hm && !(lv && lv.entrypoint !== 'sdk-cli');
  if (hide && /double-shot-latte/i.test(c.proj)) return null;               // 1) 프로젝트 폴더 이름만으로 판정(파일을 읽지 않음)
  const tail = readChunk(c.full, 256 * 1024, true);                          // 2) 뒤쪽만 읽어 제목·마지막 질문으로 판정
  const lastPrompt = lastMatch(tail, /"lastPrompt":"((?:[^"\\]|\\.)*)"/g) || '';
  let title = lastMatch(tail, /"aiTitle":"((?:[^"\\]|\\.)*)"/g) || '';
  if (hide && (AUTO_RE.test(title) || AUTO_RE.test(lastPrompt))) return null;
  if (!title) title = lastMatch(readChunk(c.full, 64 * 1024, false), /"aiTitle":"((?:[^"\\]|\\.)*)"/g) || '';
  if (hide && !title && !lastPrompt) return null;                            // 3) 제목도 질문도 없으면 빈 기록
  const cwd = findCwd(c.full, c.proj, lv?.cwd);                              // 4) 통과한 것만 폴더·모델을 찾는다
  if (hide && /double-shot-latte/i.test(cwd)) return null;
  // 마지막으로 쓴 모델. 꼬리에 없으면(대화가 짧은 세션) 앞쪽 1MB 에서 찾는다.
  const model = friendlyModel(lastMatch(tail, MODEL_RE) || lastMatch(readChunk(c.full, 1024 * 1024, false), MODEL_RE));
  return {
    ai: 'Claude Code', model,
    sid: c.sid, short: c.sid.slice(0, 8),
    title: title || (lastPrompt ? lastPrompt.slice(0, 40) : '(제목 없음)'),
    lastPrompt: lastPrompt.replace(/\s+/g, ' ').slice(0, 120),
    cwd, folder: cwd ? basename(cwd) || cwd : '',
    mtime: new Date(c.mtimeMs).toISOString(), mtimeMs: c.mtimeMs,
    live: !!lv, pid: lv ? lv.pid : null,
    addr: hm ? hm.addr : '', where: hm ? hm.where : '',
  };
}

// 반환: 행 배열 (addr/where 는 자동 복원 기록 기준의 보조 값. 정확한 창 연결은 호출한 쪽이 덮어쓴다)
export function collectClaude({ days, limit, all, live, map }) {
  const cands = listCandidates({ live, map, cutoff: Date.now() - days * 86400000, all });
  const rows = [];
  let extra = 0;
  for (const c of cands) {
    const lv = live.get(c.sid), hm = map.get(c.sid);
    const must = !!(lv || hm);
    if (!must && extra >= limit) continue;                       // 일반 세션은 limit 개까지만
    const row = buildRow(c, { lv, hm, all });
    if (!row) continue;
    if (!must) extra++;
    rows.push(row);
  }
  return rows;
}
