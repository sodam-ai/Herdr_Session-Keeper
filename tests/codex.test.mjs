// Codex 세션 지원 시험: 가짜 SQLite(threads 표)로 목록·숨김 규칙·깨진 파일·복구 분기를 확인한다.
// 실제 Codex 데이터·Herdr 는 읽지도 열지도 않는다 (CODEX_HOME/USERPROFILE/APPDATA/LOCALAPPDATA 를 가짜로 돌리고 SESSIONS_NO_HERDR=1).
import { spawnSync } from 'node:child_process';
delete process.env.CLAUDE_CONFIG_DIR;   // 이 시험은 가짜 APPDATA 로 Claude 데이터 위치를 격리한다. 개발 PC 가 CLAUDE_CONFIG_DIR 을 지정해도 실제 폴더를 읽지 않게 한다
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

delete process.env.SESSIONS_NO_CODEX;     // 이 시험은 Codex 읽기가 켜진 상태를 전제한다(바깥에서 끄고 실행해도 영향 없게)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(ROOT, 'sessions.mjs');
const base = join(tmpdir(), 'session-keeper-codex-test-' + Date.now());
const emptyApp = join(base, 'appdata'), fakeHome = join(base, 'home'), codexDir = join(base, 'codex-home'), noLocal = join(base, 'nolocal'), noKeeper = join(base, 'no-keeper');
for (const d of [emptyApp, fakeHome, codexDir, noLocal, noKeeper]) mkdirSync(d, { recursive: true });
let pass = 0, fail = 0; const out = [];
const ok = (n, c, d = '') => { c ? pass++ : fail++; out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <-- ' + d}`); };
const baseEnv = () => { const e = { ...process.env, APPDATA: emptyApp, USERPROFILE: fakeHome, LOCALAPPDATA: noLocal, CODEX_HOME: codexDir, SESSIONS_NO_HERDR: '1', SESSIONS_KEEPER_DIR: noKeeper }; delete e.SESSIONS_NO_CODEX; return e; };   // 키퍼 기록(복구 대기)도 빈 폴더로: 실제 session-map.json 이 시험 결과에 섞이지 않게
const run = (args, env = {}) => spawnSync('node', [TOOL, ...args], { encoding: 'utf8', timeout: 90000, maxBuffer: 1 << 26, env: { ...baseEnv(), ...env } });
const emit = process.emitWarning; process.emitWarning = () => {};
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite'); process.emitWarning = emit;

const NOW = Math.floor(Date.now() / 1000), DAY = 86400;
const ID = (n) => `01a19${String(n).padStart(3, '0')}-0000-7000-8000-${String(n).padStart(12, '0')}`;   // UUID 형식(앞부분 시간순 v7 모양)
function makeDb(file, columns, rows) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE threads (${columns.map((c) => c + (c === 'updated_at' || c === 'archived' ? ' INTEGER' : ' TEXT')).join(', ')})`);
  const ins = db.prepare(`INSERT INTO threads (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  for (const r of rows) ins.run(...columns.map((c) => (r[c] === undefined ? null : r[c])));
  db.close();
}
const COLS = ['id', 'updated_at', 'title', 'name', 'first_user_message', 'preview', 'cwd', 'model', 'archived', 'thread_source'];

try {
  makeDb(join(codexDir, 'state_5.sqlite'), COLS, [
    { id: ID(1), updated_at: NOW - 3600, title: '정상 코덱스 제목', cwd: '\\\\?\\C:\\Users\\PC\\proj-a', model: 'gpt-6.1-sol', archived: 0, thread_source: 'user', preview: '미리보기 글' },
    { id: ID(2), updated_at: NOW - 3600, title: '하위 에이전트 스레드', archived: 0, thread_source: 'subagent' },
    { id: ID(3), updated_at: NOW - 3600, title: '보관된 스레드', archived: 1, thread_source: 'user' },
    { id: ID(4), updated_at: NOW - 3600, title: '', first_user_message: '', preview: '', archived: 0, thread_source: 'user' },
    { id: ID(5), updated_at: NOW - 60 * DAY, title: '오래된 스레드', cwd: 'C:\\old', model: 'gpt-5', archived: 0, thread_source: 'user' },
    { id: 'not-a-uuid', updated_at: NOW - 3600, title: '형식 틀린 ID', archived: 0, thread_source: 'user' },
    { id: ID(6), updated_at: (NOW - 7200) * 1000, title: '', name: '이름만 있는 스레드', archived: 0, thread_source: 'user', model: 'gpt-6.1-sol' },        // 밀리초 단위 시각
    { id: ID(7), updated_at: NOW - 30, title: '방금 쓰인 스레드', cwd: 'C:\\', archived: 0, thread_source: 'user' },                                          // 30초 전
    { id: ID(8), updated_at: NOW - 5 * DAY, title: '제목은 없고 첫 질문만', first_user_message: '첫 질문 내용이 제목 대신 쓰임\n줄바꿈 포함', archived: 0, thread_source: 'user' },
  ]);
  makeDb(join(codexDir, 'state_4.sqlite'), COLS, [{ id: ID(99), updated_at: NOW, title: '옛 버전 DB 의 스레드(안 보여야 함)', archived: 0, thread_source: 'user' }]);   // 번호가 낮은 옛 DB

  const j = run(['json']);
  ok('Codex json: 종료코드 0, 오류 출력 없음', j.status === 0 && !/Error|at .*\.mjs:\d+|ExperimentalWarning/.test(j.stderr), `code=${j.status} err=${j.stderr.slice(0, 200)}`);
  let rows = []; try { rows = JSON.parse(j.stdout); } catch { /* 아래에서 실패 */ }
  const by = Object.fromEntries(rows.map((r) => [r.sid, r]));
  ok('가장 높은 번호의 state_N.sqlite 만 읽는다(state_4 의 스레드는 없음)', !by[ID(99)] && !!by[ID(1)]);
  ok('모든 줄이 ai="Codex" 이고 필수 필드를 가진다', rows.length > 0 && rows.every((r) => r.ai === 'Codex' && ['sid', 'short', 'title', 'model', 'cwd', 'folder', 'mtime', 'mtimeMs', 'live', 'addr', 'where'].every((k) => k in r)), JSON.stringify(rows[0]));
  ok('정상 스레드: 제목·모델·폴더(\\\\?\\ 접두어 제거)·미리보기', by[ID(1)]?.title === '정상 코덱스 제목' && by[ID(1)]?.model === 'gpt-6.1-sol' && by[ID(1)]?.cwd === 'C:\\Users\\PC\\proj-a' && by[ID(1)]?.folder === 'proj-a' && by[ID(1)]?.lastPrompt === '미리보기 글', JSON.stringify(by[ID(1)]));
  ok('하위 에이전트(subagent)·보관됨(archived)·빈 스레드·옛 스레드(60일)·잘못된 ID 는 기본 목록에서 숨김', !by[ID(2)] && !by[ID(3)] && !by[ID(4)] && !by[ID(5)] && !rows.some((r) => r.sid === 'not-a-uuid'), Object.keys(by).join(','));
  ok('이름(name)만 있는 스레드는 이름이 제목, 밀리초 시각도 올바르게(최근 시각)', by[ID(6)]?.title === '이름만 있는 스레드' && Math.abs(by[ID(6)].mtimeMs - (NOW - 7200) * 1000) < 2000, JSON.stringify(by[ID(6)]));
  ok('제목이 없으면 첫 질문이 제목(줄바꿈은 공백으로)', by[ID(8)]?.title === '제목은 없고 첫 질문만' || by[ID(8)]?.title === '첫 질문 내용이 제목 대신 쓰임 줄바꿈 포함', by[ID(8)]?.title);
  ok('최신순 정렬', rows.every((r, i) => i === 0 || rows[i - 1].mtimeMs >= r.mtimeMs));
  ok('Codex 행은 기본적으로 live=false (창 연결은 Herdr 조회가 켜졌을 때만)', rows.every((r) => r.live === false));

  // 경계/옵션
  const r0 = run(['json', '--limit', '0']); let rows0 = []; try { rows0 = JSON.parse(r0.stdout); } catch { /* */ }
  ok('--limit 0 → 일반 Codex 스레드 0개', r0.status === 0 && rows0.length === 0, `n=${rows0.length}`);
  const r1 = run(['json', '--limit', '1']); let rows1 = []; try { rows1 = JSON.parse(r1.stdout); } catch { /* */ }
  ok('--limit 1 → Codex 스레드 최대 1개', rows1.length === 1 && rows1[0].sid === ID(7), `n=${rows1.length} ${rows1.map((x) => x.short)}`);
  const rd = run(['json', '--days', '90']); let rowsD = []; try { rowsD = JSON.parse(rd.stdout); } catch { /* */ }
  ok('--days 90 → 60일 된 스레드도 포함', rowsD.some((r) => r.sid === ID(5)));
  const ra = run(['json', '--all']); let rowsA = []; try { rowsA = JSON.parse(ra.stdout); } catch { /* */ }
  ok('--all → 하위 에이전트·보관·빈 스레드도 포함(전부)', [ID(2), ID(3), ID(4), ID(5)].every((id) => rowsA.some((r) => r.sid === id)), `n=${rowsA.length}`);
  const rn = run(['json'], { SESSIONS_NO_CODEX: '1' }); let rowsN = []; try { rowsN = JSON.parse(rn.stdout); } catch { /* */ }
  ok('SESSIONS_NO_CODEX=1 → Codex 데이터를 읽지 않음', rn.status === 0 && rowsN.length === 0, `n=${rowsN.length}`);

  // list 표시 / open 분기
  const l = run(['list']); ok('list: Codex 행이 표에 나온다', l.status === 0 && /Codex\s+01a19001/.test(l.stdout), l.stdout.slice(0, 300));
  const oOld = run(['open', ID(5), '--json', '--days', '90']); let oo = {}; try { oo = JSON.parse(oOld.stdout); } catch { /* */ }
  ok('open: 오래된(꺼진) Codex 스레드는 Codex 복구 경로까지 도달(여기선 Herdr 앱이 없어 NO_APP)', oo.code === 'NO_APP' && oOld.status === 1, oOld.stdout.slice(0, 200) + oOld.stderr.slice(0, 120));
  const oRecent = run(['open', ID(7), '--json']); let orr = {}; try { orr = JSON.parse(oRecent.stdout); } catch { /* */ }
  ok('open: 방금(2분 안) 쓰인 Codex 스레드는 RECENTLY_ACTIVE 로 거부', orr.code === 'RECENTLY_ACTIVE' && oRecent.status === 1, oRecent.stdout.slice(0, 200));
  const oPrefix = run(['open', ID(1).slice(0, 8), '--json']); let op = {}; try { op = JSON.parse(oPrefix.stdout); } catch { /* */ }
  ok('open: 앞 8자 접두어로도 Codex 스레드를 찾는다', op.code === 'NO_APP', oPrefix.stdout.slice(0, 200) + oPrefix.stderr.slice(0, 100));

  // 모듈 직접 시험
  const codexMod = await import(pathToFileURL(join(ROOT, 'lib', 'codex.mjs')).href);
  process.env.CODEX_HOME = codexDir; process.env.USERPROFILE = fakeHome;
  const lt = codexMod.collectCodex({ days: 14, limit: 0, all: false, liveTitles: ['오래된 스레드'] });
  ok('열린 Codex 창 제목(liveTitles)과 같은 스레드는 오래됐거나 limit 밖이어도 포함', lt.some((r) => r.sid === ID(5)), JSON.stringify(lt.map((r) => r.title)));
  const rest = await import(pathToFileURL(join(ROOT, 'lib', 'restore.mjs')).href);
  const rl = rest.restoreRow({ ai: 'Codex', sid: ID(1), live: true, where: '~ / 1', addr: 't3x', mtimeMs: 0, folder: '', cwd: '' });
  ok('restoreRow: 열려 있는(live) Codex 는 ALREADY_RUNNING 으로 거부', rl.code === 'ALREADY_RUNNING' && /t3x/.test(rl.message), JSON.stringify(rl));
  ok('복구 명령 문자열: Codex=codex resume <ID>, Claude=claude --resume <ID>', rest.commandFor({ ai: 'Codex', sid: ID(1) }) === `codex resume ${ID(1)}` && rest.commandFor({ ai: 'Claude Code', sid: ID(1) }) === `claude --resume ${ID(1)}`, rest.commandFor({ ai: 'Codex', sid: ID(1) }));

  // 깨진/없는 데이터
  const badHome = join(base, 'bad-codex'); mkdirSync(badHome, { recursive: true });
  writeFileSync(join(badHome, 'state_5.sqlite'), randomBytes(5000));
  const rb = run(['json'], { CODEX_HOME: badHome }); ok('깨진 SQLite 파일 → 오류 없이 빈 목록', rb.status === 0 && rb.stdout === '[]', `code=${rb.status} out=${rb.stdout.slice(0, 60)} err=${rb.stderr.slice(0, 100)}`);
  const noHome = run(['json'], { CODEX_HOME: join(base, 'does-not-exist') }); ok('Codex 데이터 폴더가 없어도 빈 목록으로 정상 종료', noHome.status === 0 && noHome.stdout === '[]', noHome.stderr.slice(0, 100));
  const emptyDb = join(base, 'empty-codex'); mkdirSync(emptyDb, { recursive: true }); new DatabaseSync(join(emptyDb, 'state_5.sqlite')).close();
  const re = run(['json'], { CODEX_HOME: emptyDb }); ok('threads 표가 없는 DB → 오류 없이 빈 목록', re.status === 0 && re.stdout === '[]', `out=${re.stdout.slice(0, 60)} err=${re.stderr.slice(0, 100)}`);
  const minDb = join(base, 'min-codex'); mkdirSync(minDb, { recursive: true });
  makeDb(join(minDb, 'state_5.sqlite'), ['id', 'updated_at', 'title'], [{ id: ID(50), updated_at: NOW - 100, title: '최소 컬럼 DB' }]);
  const rm = run(['json'], { CODEX_HOME: minDb }); let rmr = []; try { rmr = JSON.parse(rm.stdout); } catch { /* */ }
  ok('컬럼이 적은 DB(id·updated_at·title 만)도 읽는다(버전 차이 대비)', rm.status === 0 && rmr.length === 1 && rmr[0].title === '최소 컬럼 DB' && rmr[0].model === '' && rmr[0].cwd === '', JSON.stringify(rmr));
  const fallbackHome = join(base, 'fb-home'); mkdirSync(join(fallbackHome, '.codex'), { recursive: true });
  makeDb(join(fallbackHome, '.codex', 'state_5.sqlite'), COLS, [{ id: ID(60), updated_at: NOW - 100, title: '~/.codex 폴백', archived: 0, thread_source: 'user' }]);
  const rf = run(['json'], { CODEX_HOME: '', USERPROFILE: fallbackHome }); let rfr = []; try { rfr = JSON.parse(rf.stdout); } catch { /* */ }
  ok('CODEX_HOME 이 비어 있으면 ~/.codex_runtime → ~/.codex 순으로 찾는다', rfr.length === 1 && rfr[0].title === '~/.codex 폴백', rf.stdout.slice(0, 200));
} finally {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* 임시 폴더 정리 실패는 무시 */ }
}
console.log(out.join('\n')); console.log(`\n합계: PASS ${pass} / FAIL ${fail}`); process.exit(fail ? 1 : 0);
