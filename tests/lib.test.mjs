// lib/ 순수 함수 시험: 창↔세션 연결(프로세스 계보·Codex 제목), 모델 이름, 공용 도구. (파일·프로세스·Herdr 를 읽지 않는다)
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => import(pathToFileURL(join(ROOT, 'lib', f)).href);
const { windowsByPid, ancestorWindow, joinClaudeWindows, joinCodexWindows, windowTitleCore } = await load('join.mjs');
const { friendlyModel } = await load('claude.mjs');
const { stripExtendedPrefix, oneLine, lastMatch, fmtTime } = await load('common.mjs');
let pass = 0, fail = 0; const out = [];
const ok = (n, c, d = '') => { c ? pass++ : fail++; out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <-- ' + d}`); };
const P = (entries) => new Map(entries.map(([pid, ppid, name = 'x.exe']) => [pid, { ppid, name }]));

// ---- 프로세스 계보로 창 찾기
const wins = [{ addr: 't1', where: 'A / 1', agent: 'claude-code', shellPid: 100, fgPid: 100, title: '' }, { addr: 't2', where: 'B / 2', agent: 'claude-code', shellPid: 200, fgPid: 210, title: '' }];
const procs = P([[100, 1], [101, 100], [102, 101], [200, 1], [210, 200], [211, 210], [300, 1], [301, 300]]);
const byPid = windowsByPid(wins);
ok('windowsByPid: 셸 pid 와 앞 프로그램 pid 둘 다로 찾는다', byPid.get(100)?.addr === 't1' && byPid.get(200)?.addr === 't2' && byPid.get(210)?.addr === 't2');
ok('ancestorWindow: 손자(102)→조상 셸(100) 창 t1', ancestorWindow(102, procs, byPid)?.addr === 't1');
ok('ancestorWindow: 자기 자신이 셸이면 그 창', ancestorWindow(200, procs, byPid)?.addr === 't2');
ok('ancestorWindow: 창이 없는 계보(301→300→1)는 null', ancestorWindow(301, procs, byPid) === null);
ok('ancestorWindow: 목록에 없는 pid 는 null(충돌 없음)', ancestorWindow(9999, procs, byPid) === null);
ok('ancestorWindow: 순환 계보(a→b→a)에서도 끝난다', ancestorWindow(5, P([[5, 6], [6, 5]]), byPid) === null);
ok('ancestorWindow: 자기 자신을 부모로 가진 항목에서도 끝난다', ancestorWindow(7, P([[7, 7]]), byPid) === null);
ok('ancestorWindow: 너무 깊은 계보는 maxDepth 에서 멈춘다', ancestorWindow(1000, P(Array.from({ length: 50 }, (_, i) => [1000 + i, 1001 + i])), byPid, 5) === null);

const claudeRows = [
  { ai: 'Claude Code', sid: 'a', live: true, pid: 102, addr: 't9', where: '옛 기록' },     // 계보로 t1 과 연결되어야 함(옛 기록 값 덮어씀)
  { ai: 'Claude Code', sid: 'b', live: true, pid: 211, addr: '', where: '' },             // t2
  { ai: 'Claude Code', sid: 'c', live: true, pid: 301, addr: 't5', where: '보조 기록' },   // 계보에 창이 없음 → 보조 기록 유지
  { ai: 'Claude Code', sid: 'd', live: false, pid: null, addr: '', where: '지난 창' },     // 꺼진 세션은 건드리지 않음
  { ai: 'Codex', sid: 'e', live: true, pid: 102, addr: 't7', where: 'Codex 창' },          // Claude 가 아님 → 그대로
];
const jr = joinClaudeWindows(claudeRows, procs, wins);
ok('joinClaudeWindows: 계보로 찾은 창이 옛 기록 값보다 우선', jr[0].addr === 't1' && jr[0].where === 'A / 1', JSON.stringify(jr[0]));
ok('joinClaudeWindows: 기록이 비어 있던 새 세션도 즉시 연결', jr[1].addr === 't2' && jr[1].where === 'B / 2');
ok('joinClaudeWindows: 계보에 창이 없으면 보조 기록 유지', jr[2].addr === 't5' && jr[2].where === '보조 기록');
ok('joinClaudeWindows: 꺼진 세션·Codex 행은 그대로', jr[3].where === '지난 창' && jr[4].addr === 't7');
ok('joinClaudeWindows: 원본 배열·객체를 바꾸지 않는다(불변)', claudeRows[0].addr === 't9' && jr !== claudeRows && jr[0] !== claudeRows[0]);
ok('joinClaudeWindows: 프로세스/창 정보가 비어 있으면 입력을 그대로 돌려준다', joinClaudeWindows(claudeRows, new Map(), wins) === claudeRows && joinClaudeWindows(claudeRows, procs, []) === claudeRows);

// ---- Codex 창 제목으로 연결
ok('windowTitleCore: "제목 | 폴더" 에서 제목만, 공백·대소문자 정리', windowTitleCore('  Review   T8 Brief | PC ') === 'review t8 brief' && windowTitleCore('제목만') === '제목만' && windowTitleCore('') === '');
const cw = [{ addr: 't3x', where: '~ / 1', agent: 'codex', title: 'Review T8 brief | PC' }, { addr: 't3z', where: 'X / 1', agent: 'claude-code', title: 'Review T8 brief' }];
const cRows = [
  { ai: 'Codex', sid: 'old', title: 'Review T8 brief', mtimeMs: 1000, live: false, addr: '', where: '' },
  { ai: 'Codex', sid: 'new', title: 'review  t8 BRIEF', mtimeMs: 5000, live: false, addr: '', where: '' },     // 같은 제목 중 가장 최근
  { ai: 'Codex', sid: 'other', title: '다른 스레드', mtimeMs: 9000, live: false, addr: '', where: '' },
  { ai: 'Claude Code', sid: 'cl', title: 'Review T8 brief', mtimeMs: 9999, live: false, addr: '', where: '' },
];
const cj = joinCodexWindows(cRows, cw);
ok('joinCodexWindows: 열린 Codex 창과 같은 제목 중 가장 최근 스레드 하나만 live', cj[1].live === true && cj[1].addr === 't3x' && cj[0].live === false && cj[2].live === false, JSON.stringify(cj.map((r) => r.live)));
ok('joinCodexWindows: Claude 창/Claude 행은 연결 대상이 아님', cj[3].live === false);
ok('joinCodexWindows: 불변 + Codex 창이 없으면 입력 그대로', cRows[1].live === false && joinCodexWindows(cRows, [cw[1]]) === cRows);
const twoWin = [{ addr: 'a', where: 'W1', agent: 'codex', title: '같은 제목' }, { addr: 'b', where: 'W2', agent: 'codex', title: '같은 제목' }];
const dup = joinCodexWindows([{ ai: 'Codex', sid: '1', title: '같은 제목', mtimeMs: 1 }, { ai: 'Codex', sid: '2', title: '같은 제목', mtimeMs: 2 }, { ai: 'Codex', sid: '3', title: '같은 제목', mtimeMs: 3 }], twoWin);
ok('joinCodexWindows: 같은 제목 창이 2개면 최근 스레드 2개가 각각 다른 창과 연결', dup.filter((r) => r.live).map((r) => r.sid).sort().join() === '2,3' && new Set(dup.filter((r) => r.live).map((r) => r.addr)).size === 2, JSON.stringify(dup.map((r) => [r.sid, r.live, r.addr])));
ok('joinCodexWindows: matchTitle 이 있으면 그것으로 비교(표시용 제목과 다를 때)', joinCodexWindows([{ ai: 'Codex', sid: 'm', title: '[표시용 긴 제목]', matchTitle: 'Review T8 brief', mtimeMs: 1 }], cw)[0].live === true);

// ---- Codex resume <ID> 명령줄로 창 연결 (창 제목이 "PC" 로 바뀌어도 정확히 연결)
const { parseResumeDump } = await load('procs.mjs');
const { joinCodexResume } = await load('join.mjs');
const IDA = '01a0d0f0-aa8d-7020-90b6-4780f6a4adcb', IDB = '01a0b1c4-0291-7b10-acf9-6da24ca785b6';
const dump = [
  `10|"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\PC\\AppData\\Roaming\\npm/node_modules/@openai/codex/bin/codex.js resume ${IDA}`,
  `11|C:\\Users\\PC\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\bin\\codex.exe resume ${IDA}`,
  `20|"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\PC\\AppData\\Roaming\\npm/node_modules/@openai/codex/bin/codex.js resume ${IDB.toUpperCase()}`,
  `30|"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\PC\\AppData\\Roaming\\npm/node_modules/@openai/codex/bin/codex.js `,
  `40|codex.exe app-server --listen unix:// --analytics-default-enabled`,
  `50|node.exe C:\\work\\server.js resume ${IDA}`,
  `60|codex.exe resume not-a-uuid`,
  '쓰레기 줄', '', `70|`,
].join('\n');
const rm = parseResumeDump(dump);
ok('parseResumeDump: resume <UUID> 가 있는 codex 프로세스만 뽑는다', rm.get(10) === IDA && rm.get(11) === IDA && rm.get(20) === IDB && rm.size === 3, JSON.stringify([...rm]));
ok('parseResumeDump: 대문자 UUID 는 소문자로, 새로 켠 창(ID 없음)·app-server·codex 가 아닌 프로세스·UUID 아닌 값은 제외', rm.get(20) === IDB && !rm.has(30) && !rm.has(40) && !rm.has(50) && !rm.has(60));
ok('parseResumeDump: 빈 입력·null 도 안전', parseResumeDump('').size === 0 && parseResumeDump(null).size === 0 && parseResumeDump(undefined).size === 0);
const rwins = [{ addr: 't9', where: 'W / a', agent: 'codex', shellPid: 900, fgPid: 910, title: 'PC' }, { addr: 't8', where: 'W / b', agent: 'codex', shellPid: 800, fgPid: 810, title: 'PC' }];
const rprocs = P([[900, 1], [910, 900], [10, 910], [11, 10], [800, 1], [20, 800]]);
const crow = [{ ai: 'Codex', sid: IDA, title: 'A', mtimeMs: 1, live: false }, { ai: 'Codex', sid: IDB, title: 'B', mtimeMs: 2, live: false }, { ai: 'Codex', sid: 'zzz', title: 'C', mtimeMs: 3, live: false }, { ai: 'Claude Code', sid: IDA, title: 'X', live: false }];
const rj = joinCodexResume(crow, rm, rprocs, rwins);
ok('joinCodexResume: 창 제목이 "PC" 여도 ID 로 각 창에 연결', rj.rows[0].live && rj.rows[0].addr === 't9' && rj.rows[1].live && rj.rows[1].addr === 't8', JSON.stringify(rj.rows.map((r) => [r.sid, r.live, r.addr])));
ok('joinCodexResume: 연결 안 된 행·Claude 행은 그대로, 이어진 창 주소 집합을 돌려준다', !rj.rows[2].live && !rj.rows[3].live && rj.addrs.has('t9') && rj.addrs.has('t8') && rj.addrs.size === 2);
ok('joinCodexResume: 입력은 바뀌지 않는다(불변)', crow[0].live === false && crow[0].addr === undefined);
ok('joinCodexResume: 같은 ID 의 node/codex.exe 두 프로세스가 같은 창이어도 한 번만', rj.rows.filter((r) => r.sid === IDA && r.ai === 'Codex' && r.live).length === 1);
ok('joinCodexResume: 비어 있는 입력(resume·프로세스·창)은 입력 그대로', joinCodexResume(crow, new Map(), rprocs, rwins).rows === crow && joinCodexResume(crow, rm, new Map(), rwins).rows === crow && joinCodexResume(crow, rm, rprocs, []).rows === crow && joinCodexResume(crow, null, rprocs, rwins).rows === crow);
ok('joinCodexResume: 창을 못 찾는 프로세스(계보가 창 밖)는 무시', joinCodexResume(crow, new Map([[9999, IDA]]), rprocs, rwins).rows === crow);
// 제목 비교는 이미 이어진 창을 제외하고 남은 창에만 적용된다(이중 연결 방지)
const left = joinCodexWindows(rj.rows, rwins.filter((w) => !rj.addrs.has(w.addr)));
ok('resume 로 이어진 창은 제목 비교 대상에서 빠진다(결과 변화 없음)', left === rj.rows);

// ---- 모델 이름
for (const [id, want] of [['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-opus-4-1-20250805', 'Opus 4.1'], ['claude-fable-5-1', 'Fable 5.1'], ['claude-3-5-sonnet-20241022', 'Sonnet 3.5'], ['claude-haiku-4-5', 'Haiku 4.5'], ['claude-sonnet-4-20250514', 'Sonnet 4'], ['', ''], [null, '']]) {
  ok(`friendlyModel(${JSON.stringify(id)}) = ${JSON.stringify(want)}`, friendlyModel(id) === want, friendlyModel(id));
}
// ---- 공용 도구
ok('stripExtendedPrefix: \\\\?\\ 접두어만 제거', stripExtendedPrefix('\\\\?\\C:\\Users\\PC') === 'C:\\Users\\PC' && stripExtendedPrefix('C:\\x') === 'C:\\x' && stripExtendedPrefix(null) === '');
ok('oneLine: 줄바꿈·연속 공백을 한 칸으로, 길이 제한', oneLine('a\n b\t\tc', 10) === 'a b c' && oneLine('x'.repeat(50), 5) === 'xxxxx' && oneLine(undefined, 5) === '');
ok('lastMatch: 마지막 일치와 JSON 이스케이프 복원', lastMatch('"t":"a" "t":"b\\"c"', /"t":"((?:[^"\\]|\\.)*)"/g) === 'b"c' && lastMatch('없음', /"t":"(.*)"/g) === null);
ok('fmtTime: MM-DD HH:MM 형식', /^\d\d-\d\d \d\d:\d\d$/.test(fmtTime(Date.now())));

console.log(out.join('\n')); console.log(`\n합계: PASS ${pass} / FAIL ${fail}`); process.exit(fail ? 1 : 0);
