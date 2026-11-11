// 경계·실패 상황 시험(배포 전 점검용): 잘못된 입력, 손상된 기록 파일, 이상한 폴더 이름, 대량 데이터, 읽는 도중 파일이 바뀌는 경우.
// 실제 세션·키퍼 기록·Herdr 는 읽지도 쓰지도 않는다(가짜 APPDATA · SESSIONS_KEEPER_DIR · SESSIONS_NO_HERDR=1 · 임시 폴더).
import { spawnSync } from 'node:child_process';
delete process.env.CLAUDE_CONFIG_DIR;   // 이 시험은 가짜 APPDATA 로 Claude 데이터 위치를 격리한다. 개발 PC 가 CLAUDE_CONFIG_DIR 을 지정해도 실제 폴더를 읽지 않게 한다
import { mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, uptime } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(ROOT, 'sessions.mjs');
const M = await import(pathToFileURL(join(ROOT, 'herdr-mod', 'session-keeper', 'model.js')).href);
let pass = 0, fail = 0; const out = [];
const ok = (n, c, d = '') => { c ? pass++ : fail++; out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <-- ' + d}`); };
const parse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

const base = join(tmpdir(), 'session-keeper-edge-' + Date.now());
const fake = join(base, 'appdata'), fakeHome = join(base, 'home'), codexDir = join(base, 'codex');
const proj = join(fake, 'claude-code', 'projects', 'P1');
for (const d of [proj, join(fake, 'claude-code', 'sessions'), fakeHome, codexDir]) mkdirSync(d, { recursive: true });
const env = (kdir, extra = {}) => ({ ...process.env, APPDATA: fake, USERPROFILE: fakeHome, CODEX_HOME: codexDir, SESSIONS_NO_HERDR: '1', SESSIONS_KEEPER_DIR: kdir, SESSIONS_PLAN_FILE: join(kdir, 'plan.txt'), ...extra });
const run = (kdir, args, extra) => { const t = Date.now(); const r = spawnSync('node', [TOOL, ...args], { encoding: 'utf8', timeout: 120000, maxBuffer: 1 << 28, env: env(kdir, extra) }); r.ms = Date.now() - t; return r; };
const mkKdir = (name, map, last) => {
  const d = join(base, name); mkdirSync(d, { recursive: true });
  if (map !== undefined) writeFileSync(join(d, 'session-map.json'), map);
  if (last !== undefined) writeFileSync(join(d, 'LAST-RESTORE.txt'), last);
  return d;
};
const iso = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const curBoot = iso(Date.now() - uptime() * 1000);

try {
  // ---- A. 잘못된 입력: 충돌 없이 거부하고, 아무 것도 바꾸지 않는다
  const kA = mkKdir('A', '{}');
  const cases = [
    ['forget', ''], ['forget', 'abc'], ['forget', 'x;y'], ['forget', '"; calc'], ['forget', 'a'.repeat(200)], ['forget', '../../etc'],
    ['recover', ''], ['recover', 't3;calc'], ['recover', 't3\nt4'], ['recover', 't'.repeat(500)], ['recover', '$(calc)'],
    ['plan', ''], ['plan', 'zzz'], ['open', 'nothex'], ['open', '00000000-0000-4000-8000-000000000000'], ['focus', 'bad addr'], ['focus', 't' + 'z'.repeat(50)], ['nonsense'],
  ];
  const bad = cases.map((c) => [c, run(kA, [...c, '--json'])]).filter(([, r]) => !(r.status === 1 || r.status === 2) || /Traceback|TypeError|ReferenceError|at .*\.mjs:\d+/.test(r.stderr));
  ok('잘못된 입력 18가지(공백·대소문자는 정리해서 받아들이는 것이 정상이라 제외): 전부 종료코드 1/2 로 깔끔히 거부(충돌·스택 추적 없음)', bad.length === 0, JSON.stringify(bad.map(([c, r]) => [c.join(' ').slice(0, 30), r.status, r.stderr.slice(0, 80)])));
  ok('잘못된 입력 뒤에도 지도 파일이 그대로', readFileSync(join(kA, 'session-map.json'), 'utf8') === '{}');
  ok('존재하지 않는 세션 제외(forget)는 ok:false 로 알림', parse(run(kA, ['forget', 'abcdef12', '--json']).stdout)?.ok === false);

  // ---- B. 손상·이상한 기록 파일: 목록은 계속 나온다
  const weird = {
    '빈 파일': '', '깨진 JSON': '{깨짐', '배열': '[1,2,3]', '문자열': '"hello"', 'null': 'null', 'BOM+정상': '\uFEFF{}',
    '항목이 숫자': JSON.stringify({ t1: 5, t2: null, t3: 'x', t4: [] }), '필수 필드 없음': JSON.stringify({ t1: {}, t2: { sid: '' }, t3: { addr: 't3' } }),
    'sid 가 UUID 아님': JSON.stringify({ t1: { addr: 't1', sid: 'not-a-uuid', orphan: true } }), '시각이 쓰레기': JSON.stringify({ t1: { addr: 't1', sid: randomUUID(), seen: 'zzz', boot: 12345, attempts: 'many', orphan: 'yes' } }),
    '아주 긴 이름·이모지': JSON.stringify({ t1: { addr: 't1', sid: randomUUID(), where: '가'.repeat(5000) + '😀', space: '<b>x</b>', tab: '\u202Eevil', orphan: true } }),
  };
  const badB = [];
  for (const [name, body] of Object.entries(weird)) {
    const r = run(mkKdir('B-' + name.replace(/\W/g, ''), body, '\u0000\u0001\uFFFD판정: ??'), ['json']);
    const rows = parse(r.stdout);
    if (r.status !== 0 || !Array.isArray(rows)) badB.push([name, r.status, r.stderr.slice(0, 120)]);
  }
  ok(`손상·이상한 지도 파일 ${Object.keys(weird).length}가지: 목록(json)이 종료코드 0 + 올바른 JSON`, badB.length === 0, JSON.stringify(badB));
  const lastOdd = parse(run(mkKdir('B-last', '{}', '\u0000\u0001판정:\n판정: 이상한 말\n'), ['last']).stdout);
  ok('LAST-RESTORE.txt 가 쓰레기여도 last 는 죽지 않는다(unknown 단계 또는 null)', lastOdd === null || lastOdd?.level === 'unknown', JSON.stringify(lastOdd));

  // ---- C. 이상한 폴더 이름(공백·작은따옴표·한글)에서도 키퍼가 실제로 백그라운드 실행되는가
  const kC = join(base, "경로 with space & 'quote'"); mkdirSync(kC, { recursive: true });
  copyFileSync(join(ROOT, 'session-keeper.ps1'), join(kC, 'session-keeper.ps1')); writeFileSync(join(kC, 'session-map.json'), '{}');
  const rc = parse(run(kC, ['recover', 'all', '--json']).stdout);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 500)); } return fn(); };
  ok("공백·작은따옴표·한글이 든 폴더에서도 recover 가 실제로 돌아 결과 파일을 쓴다", rc?.ok === true && await waitFor(() => existsSync(join(kC, 'LAST-RESTORE.txt')), 30000), JSON.stringify(rc));
  const rp = parse(run(kC, ['plan', 'start', '--json']).stdout);
  ok("같은 폴더에서 미리보기 시작도 실제로 돌아 결과 파일을 만든다", rp?.ok === true && await waitFor(() => existsSync(join(kC, 'plan.txt')), 30000), JSON.stringify(rp));
  await new Promise((r) => setTimeout(r, 2500));

  // ---- D. 대량 데이터: 복구 대기 600건(그중 100건은 대화 파일 있음) — 시간·정확성
  const N = 600, withFile = 100, map = {};
  for (let i = 0; i < N; i++) {
    const sid = randomUUID();
    map['t' + i] = { addr: 't' + i, where: `공간${i % 12} / 탭${i}`, space: `공간${i % 12}`, tab: `탭${i}`, sid, cwd: 'C:\\Users\\PC', boot: '2000-01-01T00:00:00', seen: curBoot, attempts: i % 5, orphan: i % 2 === 0 };
    if (i < withFile) writeFileSync(join(proj, sid + '.jsonl'), Array.from({ length: 120 }, () => JSON.stringify({ type: 'attachment', sessionId: sid, content: 'x'.repeat(200) }) + '\n').join('') + JSON.stringify({ type: 'ai-title', aiTitle: `제목 ${i}`, sessionId: sid }) + '\n');
  }
  const big = run(mkKdir('D', JSON.stringify(map)), ['json']);
  const bigRows = parse(big.stdout) || [];
  const pend = bigRows.filter((r) => r.keeper?.pending);
  ok(`대량(복구 대기 ${N}건): 종료코드 0, 모두 목록에 나옴(기록 없는 ${N - withFile}건은 '복구 불가' 행)`, big.status === 0 && pend.length === N && bigRows.filter((r) => r.missing).length === N - withFile, `status=${big.status} pend=${pend.length} missing=${bigRows.filter((r) => r.missing).length}`);
  ok(`대량: 목록 생성 ${big.ms}ms (기준 20000ms 이하)`, big.ms <= 20000);
  const t0 = Date.now();
  const items = M.buildItems(bigRows, [], { home: 'C:\\Users\\PC' });
  const gp = M.groupPending(items.pending), gl = M.groupLive(items.live), gd = M.groupDead(items.dead);
  const msModel = Date.now() - t0;
  ok(`대량: 화면 로직(묶기·정렬) ${msModel}ms (기준 1000ms 이하), 복구 대기 ${items.pending.length}건 누락·중복 없음`, msModel <= 1000 && items.pending.length === N && gp.reduce((n, g) => n + g.count, 0) === N && new Set(gp.flatMap((g) => g.items.map((x) => x.key))).size === N, `${msModel}ms`);

  // ---- E. 화면 로직: 적대적 입력(아주 긴 제목·검색식 특수문자·이상한 상태값)
  const hostile = [{ ai: 'Claude Code', sid: 's1', short: 's1', title: 'ㅁ'.repeat(10000), live: false, cwd: 'C:\\a', folder: 'a', mtimeMs: 1, lastPrompt: '' }, { ai: null, sid: undefined, title: null, live: false, cwd: null, mtimeMs: NaN }, { ai: 'x', sid: 's3', title: '<script>alert(1)</script>', live: true, addr: 't1', status: 'weird', cwd: '', mtimeMs: 'abc' }];
  let threw = '';
  try {
    const b = M.buildItems(hostile, [{ address: 't1', status: 'working', app: null, program: null, title: null, space_name: null, tab_name: undefined }], { home: '' });
    M.groupDead(b.dead, { filter: '([.*+?^${}()|[\\]\\\\' }); M.groupLive(b.live); M.groupPending(b.pending); M.lastBanner({ verdict: null, level: undefined, at: 5, tally: {} });
    for (const f of ['([.*+?^${}()|[\\]\\\\', '\\', '%', '\u0000', 'ㅁ'.repeat(20000)]) b.live.concat(b.dead).forEach((x) => M.matchItem(x, f));
    M.plainTally('대상 99999999999999999999개 = 성공 1 / 실패 2 / 건너뜀 3'); M.ago(NaN); M.ago(Infinity); M.ago(-5);
  } catch (e) { threw = String(e && e.stack || e).slice(0, 300); }
  ok('적대적 입력(null·NaN·1만 자 제목·검색식 특수문자·HTML)에도 예외 없이 처리', threw === '', threw);

  // ---- F. 읽는 도중 지도 파일이 계속 다시 쓰이는 경우(키퍼가 1분마다 쓴다): 읽기 20번 모두 죽지 않는다
  const kF = mkKdir('F', JSON.stringify(map));
  const goodText = JSON.stringify(map);
  writeFileSync(join(kF, 'good.json'), goodText);                                 // 명령줄로 큰 데이터를 넘기면 윈도우 길이 한도를 넘으므로 파일에서 읽게 한다
  const writerSrc = "const fs=require('fs');const [f,gf]=process.argv.slice(1);const g=fs.readFileSync(gf,'utf8');let i=0;setInterval(()=>{try{fs.writeFileSync(f,i%3===0?g.slice(0,g.length>>1):g)}catch{}i++;if(i%50===0)process.stdout.write('w')},10);";
  const wr = (await import('node:child_process')).spawn('node', ['-e', writerSrc, join(kF, 'session-map.json'), join(kF, 'good.json')], { stdio: ['ignore', 'pipe', 'ignore'] });
  let writes = 0; wr.stdout.on('data', (d) => { writes += d.length * 50; });   // 50번 쓸 때마다 1글자
  await new Promise((r) => setTimeout(r, 500));                                   // 쓰는 쪽이 돌기 시작할 때까지
  let failedReads = 0;
  for (let i = 0; i < 20; i++) { const r = run(kF, ['json']); if (r.status !== 0 || !Array.isArray(parse(r.stdout))) failedReads++; }
  await new Promise((r) => setTimeout(r, 300));                                   // 읽기 동안 막혀 있던 쓰기 횟수 알림(stdout)을 받는다
  wr.kill();
  ok(`지도 파일이 계속 다시 쓰이는 중(별도 프로세스가 반쯤 쓰인 상태까지 만들며 약 ${writes}번 이상 쓰기) 읽기 20번: 실패 ${failedReads}번`, failedReads === 0 && writes >= 100, `failed=${failedReads}`);
} finally {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* 임시 폴더 정리 실패는 무시 */ }
}

console.log(out.join('\n'));
console.log(`\n합계: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
