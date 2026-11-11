// Codex 세션 수집: Codex 가 스레드를 저장하는 SQLite(state_N.sqlite 의 threads 표)를 "읽기 전용"으로 읽는다.
// 데이터 폴더는 환경변수 CODEX_HOME(이 PC: ~/.codex_runtime)이 우선이고, 없으면 ~/.codex_runtime, ~/.codex 중 최근에 갱신된 쪽.
// SESSIONS_NO_CODEX=1 이면 Codex 데이터를 아예 읽지 않는다(시험·점검용).
import { createRequire } from 'node:module';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { UUID, stripExtendedPrefix, oneLine } from './common.mjs';

const requireCjs = createRequire(import.meta.url);

function latestStateDb(dir) {
  let best = null;
  try {
    for (const f of readdirSync(dir)) { const m = /^state_(\d+)\.sqlite$/.exec(f); if (m && (!best || Number(m[1]) > best.n)) best = { n: Number(m[1]), file: join(dir, f) }; }
  } catch { /* 폴더 없음 */ }
  return best ? best.file : null;
}
const mtimeOf = (f) => { let m = 0; for (const x of [f, f + '-wal']) { try { m = Math.max(m, statSync(x).mtimeMs); } catch { /* 없음 */ } } return m; };

// {dir, db} 또는 null
export function codexHome() {
  const home = process.env.USERPROFILE || homedir();
  const env = process.env.CODEX_HOME;
  const found = [...new Set([...(env ? [env] : []), join(home, '.codex_runtime'), join(home, '.codex')])]
    .map((dir) => ({ dir, db: latestStateDb(dir) })).filter((x) => x.db && existsSync(x.db));
  if (!found.length) return null;
  const fromEnv = env && found.find((x) => x.dir === env);
  return fromEnv || found.sort((a, b) => mtimeOf(b.db) - mtimeOf(a.db))[0];
}

function openReadOnly(file) {
  const emit = process.emitWarning;
  process.emitWarning = () => {};                         // node:sqlite 의 "실험 기능" 경고가 오류 출력에 섞이지 않게
  try {
    const { DatabaseSync } = requireCjs('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    return db;
  } finally { process.emitWarning = emit; }
}

const toMs = (v) => { const n = Number(v) || 0; return n > 1e12 ? n : n * 1000; };

function toRow(r) {
  const title = oneLine(r.name || r.title || r.first_user_message || r.preview, 100);
  const cwd = stripExtendedPrefix(r.cwd);
  const ms = toMs(r.updated_at);
  return {
    ai: 'Codex', model: r.model || '',
    sid: String(r.id), short: String(r.id).slice(0, 8),
    title: title || '(제목 없음)', matchTitle: oneLine(r.name || r.title, 200),
    lastPrompt: oneLine(r.preview || r.first_user_message, 120),
    cwd, folder: cwd ? basename(cwd) || cwd : '',
    mtime: new Date(ms).toISOString(), mtimeMs: ms,
    live: false, pid: null, addr: '', where: '',
  };
}

function selectThreads(db, { days, limit, all, liveTitles, mustIds = [] }) {
  const cols = new Set(db.prepare('PRAGMA table_info(threads)').all().map((c) => c.name));
  if (!cols.has('id') || !cols.has('updated_at')) return [];
  const sel = ['id', 'updated_at', ...['title', 'name', 'first_user_message', 'preview', 'cwd', 'model', 'archived', 'thread_source'].filter((c) => cols.has(c))].join(',');
  const where = [], params = [];
  const secs = '(CASE WHEN updated_at > 1000000000000 THEN updated_at / 1000 ELSE updated_at END)';   // 초/밀리초가 섞여도 정렬·기간 조건이 맞도록 초 단위로 맞춘다
  if (!all) {
    if (cols.has('archived')) where.push('(archived IS NULL OR archived = 0)');
    if (cols.has('thread_source')) where.push("(thread_source IS NULL OR thread_source = 'user')");   // 하위 에이전트(subagent) 스레드는 사용자가 연 세션이 아니다
    where.push(`${secs} >= ?`); params.push(Math.floor((Date.now() - days * 86400000) / 1000));
  }
  const rows = db.prepare(`SELECT ${sel} FROM threads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${secs} DESC LIMIT ?`).all(...params, all ? 400 : limit);
  // 열려 있는 Codex 창이 쓰는 스레드는 오래됐거나 limit 밖이어도 반드시 포함한다(제목으로 찾는다)
  for (const t of liveTitles) {
    if (!t || !(cols.has('title') || cols.has('name'))) continue;
    const q = [cols.has('title') ? 'title = ?' : null, cols.has('name') ? 'name = ?' : null].filter(Boolean);
    rows.push(...db.prepare(`SELECT ${sel} FROM threads WHERE ${q.join(' OR ')} ORDER BY updated_at DESC LIMIT 3`).all(...q.map(() => t)));
  }
  // 세션키퍼의 복구 대기 기록에 있는 스레드는 오래됐거나 limit 밖이어도 반드시 포함한다(오래 꺼 둔 뒤에도 복구 목록에서 사라지지 않게)
  const ids = [...new Set(mustIds.map(String))].filter((id) => UUID.test(id));
  if (ids.length) rows.push(...db.prepare(`SELECT ${sel} FROM threads WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids));
  return rows;
}

// 반환: 행 배열 (live/addr/where 는 비워 둔다. 열린 창과의 연결은 join.mjs 가 한다)
export function collectCodex({ days, limit, all, liveTitles = [], mustIds = [] }) {
  if (process.env.SESSIONS_NO_CODEX) return [];
  const h = codexHome();
  if (!h) return [];
  let db;
  try {
    db = openReadOnly(h.db);
    const seen = new Set();
    const out = [];
    for (const r of selectThreads(db, { days, limit, all, liveTitles, mustIds })) {
      if (!UUID.test(String(r.id)) || seen.has(r.id)) continue;
      seen.add(r.id);
      const row = toRow(r);
      const empty = !oneLine(r.name || r.title || r.first_user_message || r.preview, 5);
      if (empty && !all) continue;                              // 제목도 첫 질문도 없는 빈 스레드는 기본 숨김
      out.push(row);
    }
    return out;
  } catch (e) {
    if (process.env.SESSIONS_DEBUG) console.error('[Codex 읽기 실패]', e && e.message);
    return [];
  } finally { try { db?.close(); } catch { /* 이미 닫힘 */ } }
}
