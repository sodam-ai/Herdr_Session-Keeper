// sessions.mjs - 세션키퍼의 목록·복구 도구 (Claude Code + Codex).
//
//   node sessions.mjs list [--days 14] [--limit 60] [--all]   표로 보기 (--all: 짧은/자동 세션도 포함)
//   node sessions.mjs json [--days 14] [--limit 60] [--all]   같은 내용을 JSON 으로 (세션키퍼 창이 사용)
//   node sessions.mjs open <세션ID 또는 앞 6자 이상>           Herdr 앱에 새 탭을 열어 이어서 시작 (claude --resume / codex resume)
//   node sessions.mjs focus <창 주소>                          실행 중인 세션의 Herdr 창으로 화면만 이동
//   node sessions.mjs last                                     가장 최근 자동 복구 결과(LAST-RESTORE.txt 의 판정·집계)를 JSON 으로
//   node sessions.mjs forget <세션ID 앞 6자 이상> [--json]      복구 대기 목록에서 빼기 (session-keeper.ps1 -Mode Forget)
//   node sessions.mjs forget-old [--json]                      "닫히기 직전"이 아닌 옛 복구 대기 항목을 한꺼번에 빼기 (키퍼가 먼저 백업)
//   node sessions.mjs update-state                             Herdr 앱 업데이트 상태(JSON) / update [--json]: 앱 업데이트 적용(창만 껐다 켬) / update-auto on|off [--json]: 자동 업데이트 켜기/끄기
//   node sessions.mjs recover <창 주소|all> [--json]            복구 대기 작업을 키퍼로 복구 (빈 셸 입력 / 새 탭). 백그라운드로 시작하고 바로 돌아온다
//   node sessions.mjs plan start | read                        "전부 복구" 미리보기: 키퍼 -Plan 을 백그라운드로 돌리고(start) 항목별 계획을 읽는다(read: JSON)
//
// 읽기만 하는 명령은 list/json. open 만 Herdr 앱에 새 탭을 하나 연다(기존 창은 건드리지 않음).
// 이미 어딘가에서 실행 중인 세션은 중복 실행(같은 대화에 두 창이 쓰는 사고)을 막기 위해 열지 않는다.
// 환경변수(시험·점검용): SESSIONS_NO_CODEX=1 Codex 데이터를 읽지 않음 / SESSIONS_NO_HERDR=1 Herdr·프로세스 조회를 건너뜀 / CODEX_HOME Codex 데이터 폴더.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UUID, fmtTime } from './lib/common.mjs';
import { liveSessions, herdrMap, collectClaude } from './lib/claude.mjs';
import { collectCodex } from './lib/codex.mjs';
import { herdrWindows, focusWindow } from './lib/herdr.mjs';
import { processSnapshot, codexResumeSnapshot } from './lib/procs.mjs';
import { joinClaudeWindows, joinCodexWindows, joinCodexResume } from './lib/join.mjs';
import { restoreRow, stubRow } from './lib/restore.mjs';
import { keeperIndex, decorateKeeper, missingStubs, lastRestore, keeperCommand, parsePlan, readAppUpdate, SID_RE, ADDR_RE } from './lib/keeper.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// kit.env(설치 도구가 적는 파일): node/hc 위치가 PATH 에 없는 PC 를 위해 PATH 앞에 붙인다. 없으면 아무것도 하지 않는다. (session-keeper.ps1 과 같은 규칙)
try {
  const ke = join(process.env.SESSIONS_KEEPER_DIR || dirname(fileURLToPath(import.meta.url)), 'kit.env');
  if (existsSync(ke)) for (const ln of readFileSync(ke, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.+)$/.exec(ln); if (!m) continue; const k = m[1]; const d = m[2].trim();
    if ((k === 'NODE_DIR' || k === 'HC_DIR') && existsSync(d) && !(';' + process.env.PATH + ';').toLowerCase().includes(';' + d.toLowerCase() + ';')) process.env.PATH = d + ';' + process.env.PATH;
    else if (k === 'APP_EXE' && !process.env.KEEPER_APP_EXE) process.env.KEEPER_APP_EXE = d;
    else if (k === 'APP_HOME' && !process.env.HERDR_APP_HOME) process.env.HERDR_APP_HOME = d;
    else if (k === 'CLAUDE_CFG' && !process.env.CLAUDE_CONFIG_DIR) process.env.CLAUDE_CONFIG_DIR = d;
  }
} catch { /* 환경 파일이 없거나 이상하면 무시 */ }

// "전부 복구" 미리보기(키퍼 -Plan)는 오래 걸릴 수 있어(창이 많으면 수십 초) 백그라운드로 돌리고 결과를 이 파일에서 읽는다. 시험에서는 SESSIONS_PLAN_FILE 로 바꾼다.
const PLAN_FILE = process.env.SESSIONS_PLAN_FILE || join(tmpdir(), 'session-keeper-plan.txt');

// 키퍼(session-keeper.ps1)와 그 기록 파일이 있는 폴더. 시험에서는 SESSIONS_KEEPER_DIR 로 임시 폴더를 가리킨다.
const KDIR = process.env.SESSIONS_KEEPER_DIR || dirname(fileURLToPath(import.meta.url));
const MAP_FILE = join(KDIR, 'session-map.json');
const args = process.argv.slice(2);
const cmd = args[0] || 'list';
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const flag = (name) => args.includes('--' + name);
// 0 은 유효한 값이다(예: --limit 0 = 일반 꺼진 세션은 안 가져옴). 숫자가 아니거나 음수면 기본값.
const num = (name, dflt) => { const raw = opt(name, ''); const v = Number(raw); return raw !== '' && Number.isFinite(v) && v >= 0 ? v : dflt; };

// 모든 AI 의 세션을 모아 열려 있는 Herdr 창과 연결한다.
async function collectAll({ days, limit, all }) {
  const procsP = processSnapshot(), windowsP = herdrWindows(), resumeP = codexResumeSnapshot();   // 먼저 시작해 두고 파일 읽기와 겹친다
  const index = keeperIndex(MAP_FILE);                                     // 복구 대기 기록(Claude·Codex 공통)
  const claude = collectClaude({ days, limit, all, live: liveSessions(), map: herdrMap(MAP_FILE) });
  const windows = await windowsP;
  const resume = await resumeP;                                            // pid -> 대화ID (codex resume <ID> 로 켠 창)
  const procs = await procsP;
  const liveTitles = windows.filter((w) => w.agent === 'codex').map((w) => String(w.title).split(' | ')[0].trim()).filter(Boolean);
  const codex = collectCodex({ days, limit, all, liveTitles, mustIds: [...index.keys(), ...resume.values()] });   // 실행 중인 resume 대화는 --limit 과 무관하게 포함
  const byResume = joinCodexResume([...claude, ...codex], resume, procs, windows);   // 1순위: 명령줄의 ID(정확)
  const joined = joinClaudeWindows(joinCodexWindows(byResume.rows, windows.filter((w) => !byResume.addrs.has(w.addr))), procs, windows);   // 2순위: 창 제목(아직 안 이어진 창만)
  const decorated = decorateKeeper(joined, index);
  return [...decorated, ...missingStubs(decorated, index)].map(({ matchTitle, ...row }) => row).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// 키퍼 스크립트 실행. forget 은 끝날 때까지 기다리고(약 5초), recover 는 오래 걸려서(창을 3개씩 25초 간격으로 엽니다) 짧게 사는 PowerShell 이 Start-Process 로 띄우고 바로 끝난다(lib/keeper.mjs 설명 참고).
function runKeeper(kind, arg) {
  const c = keeperCommand(kind, arg, KDIR);
  if (c.error) return { ok: false, message: c.error };
  if (process.env.SESSIONS_KEEPER_DRYRUN) return { ok: true, message: 'DRYRUN ' + [c.file, ...c.args].join(' '), dryrun: [c.file, ...c.args] };
  const r = spawnSync(c.file, c.args, { encoding: 'utf8', timeout: kind.startsWith('forget') ? 25000 : 20000, windowsHide: true });
  if (r.error) return { ok: false, message: '키퍼를 실행하지 못했습니다: ' + String(r.error.message || r.error).slice(0, 120) };
  return r.status === 0 ? { ok: true, message: '' } : { ok: false, message: (r.stderr || r.stdout || '키퍼 실행 실패').trim().slice(0, 160) };
}

function resolveSid(q, rows) {
  if (UUID.test(q)) return { sid: q.toLowerCase() };
  if (q.length < 6) return { error: '세션 ID는 앞 6자 이상 입력해야 합니다.' };
  const hits = rows.filter((r) => r.sid.startsWith(q.toLowerCase()));
  if (hits.length === 1) return { sid: hits[0].sid };
  if (hits.length === 0) return { error: `"${q}" 로 시작하는 세션을 찾지 못했습니다. (기본 14일 이내, 짧은 세션 제외 — 전체 ID를 쓰거나 list --all --days 60 으로 확인)` };
  return { error: `"${q}" 로 시작하는 세션이 ${hits.length}개입니다. 더 길게 입력하세요: ` + hits.map((h) => h.short).join(', ') };
}

function emit(res, code) {
  if (flag('json')) process.stdout.write(JSON.stringify(res)); else console.log((res.ok ? '✔ ' : '✘ ') + res.message);
  process.exit(code);
}

const aiShort = (r) => (r.ai === 'Codex' ? 'Codex ' : 'Claude');
function printList(rows, days) {
  console.log(`세션 ${rows.length}개 (실행 중 ${rows.filter((r) => r.live).length}개) - 최근 ${days}일, 최신순\n`);
  console.log('상태  AI      ID(앞8)   마지막 사용     Herdr 창 / 폴더                              제목');
  for (const r of rows) {
    const where = r.where ? `${r.addr} ${r.where}` : r.folder;
    console.log(`${r.live ? ' ●  ' : ' ○  '}  ${aiShort(r)}  ${r.short}  ${fmtTime(r.mtimeMs)}   ${where.slice(0, 44).padEnd(44)} ${r.title.slice(0, 40)}`);
  }
  console.log('\n● 지금 실행 중   ○ 꺼져 있음(복구 가능)   전체 ID: node sessions.mjs json   복구: node sessions.mjs open <ID 앞 6자 이상>');
}

async function main() {
  const days = num('days', 14), limit = num('limit', 60), all = flag('all');
  if (cmd === 'json') {
    process.stdout.write(JSON.stringify(await collectAll({ days, limit, all })));
  } else if (cmd === 'list') {
    printList(await collectAll({ days, limit, all }), days);
  } else if (cmd === 'open') {
    const q = (args[1] || '').trim();
    if (!q) { console.error('사용법: node sessions.mjs open <세션ID 또는 앞 6자 이상>'); process.exit(2); }
    const rows = await collectAll({ days: num('days', 60), limit: 400, all: true });
    const rs = resolveSid(q, rows);
    if (rs.error) { console.error(rs.error); process.exit(2); }
    const res = restoreRow(rows.find((r) => r.sid === rs.sid) || stubRow(rs.sid));
    if (flag('json')) process.stdout.write(JSON.stringify(res)); else console.log((res.ok ? '✔ ' : '✘ ') + res.message);
    process.exit(res.ok ? 0 : 1);
  } else if (cmd === 'focus') {
    const addr = (args[1] || '').trim();
    if (!ADDR_RE.test(addr)) { console.error('사용법: node sessions.mjs focus <창 주소 예: t3z>'); process.exit(2); }
    const r = focusWindow(addr);
    const msg = r.ok ? `${addr} 창으로 이동했습니다.` : `이동하지 못했습니다: ${r.detail}`;
    if (flag('json')) process.stdout.write(JSON.stringify({ ok: r.ok, message: msg })); else console.log((r.ok ? '✔ ' : '✘ ') + msg);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'last') {
    process.stdout.write(JSON.stringify(lastRestore(KDIR)));                       // 가장 최근 자동 복구 결과(없으면 null)
  } else if (cmd === 'update-state') {
    process.stdout.write(JSON.stringify(readAppUpdate(KDIR)));                     // Herdr 앱 업데이트 상태 + 자동 켜짐 여부(읽기 전용)
  } else if (cmd === 'update') {
    // Herdr 앱 업데이트 적용: 키퍼가 백업 -> 파일 교체 -> 검증 후 창만 껐다 켠다(터미널은 코어가 유지). 백그라운드로 시작하고 바로 돌아온다.
    const s = readAppUpdate(KDIR);
    if (s.kind === 'none') emit({ ok: false, message: '적용할 앱 업데이트가 없습니다. (이미 최신이거나 아직 새 버전을 받지 못했습니다)' }, 1);
    const r = runKeeper('update', '');
    emit({ ok: r.ok, message: r.ok ? (r.dryrun ? r.message : `앱 업데이트(${s.installed || '?'} → ${s.staged || '새 버전'})를 시작했습니다. Herdr 창이 잠깐 닫혔다 다시 열립니다(터미널은 그대로). 다시 열린 뒤 이 창을 새로 열어 주세요.`) : r.message }, r.ok ? 0 : 1);
  } else if (cmd === 'update-auto') {
    const v = (args[1] || '').trim().toLowerCase();
    if (v !== 'on' && v !== 'off') { console.error('사용법: node sessions.mjs update-auto on | off'); process.exit(2); }
    const r = runKeeper('update-auto', v === 'on' ? 'On' : 'Off');
    emit({ ok: r.ok, message: r.ok ? (r.dryrun ? r.message : v === 'on' ? '앱 자동 업데이트를 켰습니다. Herdr 가 켜지는 순간 새 버전이 받아져 있으면 적용합니다.' : '앱 자동 업데이트를 껐습니다. 필요할 때 [앱 업데이트] 버튼으로 직접 적용하세요.') : r.message }, r.ok ? 0 : 1);
  } else if (cmd === 'forget-old') {
    // "닫히기 직전"이 아니어서 자동 복구에서 빠지는 옛 대기 항목을 한꺼번에 뺀다(화면의 [옛 항목 N개 제외]). 키퍼가 지우기 전에 백업을 만든다.
    const olds = () => [...keeperIndex(MAP_FILE).values()].filter((k) => k.pending && k.auto === false);
    const before = olds().length;
    if (before === 0) emit({ ok: false, message: '제외할 옛 항목이 없습니다. (이미 빠졌을 수 있습니다)' }, 1);
    const r = runKeeper('forget-old', '');
    if (r.dryrun) emit({ ok: true, message: r.message }, 0);
    const left = olds().length;
    const ok = r.ok && left === 0;
    emit({ ok, message: ok ? `옛 항목 ${before}개를 복구 목록에서 제외했습니다. (대화 기록은 그대로이고, 백업: session-map.json.before-forget-old-…)` : (r.message || '일부를 제외하지 못했습니다. 잠시 뒤 다시 눌러 주세요.') }, ok ? 0 : 1);
  } else if (cmd === 'forget') {
    const q = (args[1] || '').trim().toLowerCase();
    if (!SID_RE.test(q)) { console.error('사용법: node sessions.mjs forget <세션ID 앞 6자 이상>'); process.exit(2); }
    const before = [...keeperIndex(MAP_FILE).values()].filter((k) => k.sid.startsWith(q));
    if (before.length === 0) emit({ ok: false, message: '복구 목록에 없는 세션입니다. (이미 빠졌을 수 있습니다)' }, 1);
    const r = runKeeper('forget', q);
    if (r.dryrun) emit({ ok: true, message: r.message }, 0);
    const left = [...keeperIndex(MAP_FILE).values()].filter((k) => k.sid.startsWith(q)).length;
    const ok = r.ok && left === 0;
    emit({ ok, message: ok ? `복구 목록에서 제외했습니다: ${before[0].where || before[0].sid.slice(0, 8)}` : (r.message || '목록에서 제외하지 못했습니다. 잠시 뒤 다시 눌러 주세요.') }, ok ? 0 : 1);
  } else if (cmd === 'plan') {
    const sub = (args[1] || '').trim();
    if (sub === 'start') {                                                          // 미리보기를 백그라운드로 시작(입력·생성 없음). 결과는 PowerShell 이 PLAN_FILE 에 직접 쓴다
      const c = keeperCommand('plan', '', KDIR, PLAN_FILE);
      if (c.error) emit({ ok: false, message: c.error }, 1);
      if (process.env.SESSIONS_KEEPER_DRYRUN) emit({ ok: true, message: 'DRYRUN ' + [c.file, ...c.args].join(' ') }, 0);
      const r = spawnSync(c.file, c.args, { encoding: 'utf8', timeout: 20000, windowsHide: true });
      if (r.error || r.status !== 0) emit({ ok: false, message: '미리보기를 시작하지 못했습니다: ' + String((r.error && r.error.message) || r.stderr || r.stdout || '').trim().slice(0, 120) }, 1);
      emit({ ok: true, message: '미리보기를 시작했습니다.' }, 0);
    } else if (sub === 'read') {                                                    // 지금까지의 결과: {done, items:[{action,addr,where,sid8,reason}]}
      let text = '';
      try { text = readFileSync(PLAN_FILE, 'utf8'); } catch { /* 아직 없음 */ }
      process.stdout.write(JSON.stringify(parsePlan(text)));
    } else { console.error('사용법: node sessions.mjs plan start | read'); process.exit(2); }
  } else if (cmd === 'recover') {
    const t = (args[1] || '').trim();
    if (t !== 'all' && !ADDR_RE.test(t)) { console.error('사용법: node sessions.mjs recover <창 주소 예: t3z | all>'); process.exit(2); }
    const r = runKeeper('recover', t);
    emit({ ok: r.ok, message: r.ok ? (r.dryrun ? r.message : t === 'all' ? '전부 복구를 시작했습니다. 창이 3개씩 열리며 몇 분 걸릴 수 있습니다. 이 창은 닫아도 됩니다.' : `${t} 창 복구를 시작했습니다.`) : r.message }, r.ok ? 0 : 1);
  } else {
    console.error('명령: list | json | open <ID> | focus <창 주소> | last | forget <ID> | recover <창 주소|all>');
    process.exit(2);
  }
}
await main();
