// 복구 대기 기능 시험: lib/keeper.mjs (키퍼 기록 읽기) + sessions.mjs 의 last / forget / recover 명령.
// 실제 세션·키퍼 기록·Herdr 는 읽지도 쓰지도 않는다: 가짜 APPDATA·가짜 키퍼 폴더(SESSIONS_KEEPER_DIR)·SESSIONS_NO_HERDR=1 로만 돌린다.
// (forget 은 임시 폴더에 복사한 session-keeper.ps1 을 진짜로 실행해 지도 파일에서 빠지는지 확인한다. recover 는 SESSIONS_KEEPER_DRYRUN 으로 명령만 확인한다.)
import { spawnSync } from 'node:child_process';
delete process.env.CLAUDE_CONFIG_DIR;   // 이 시험은 가짜 APPDATA 로 Claude 데이터 위치를 격리한다. 개발 PC 가 CLAUDE_CONFIG_DIR 을 지정해도 실제 폴더를 읽지 않게 한다
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, uptime } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(ROOT, 'sessions.mjs');
const K = await import(pathToFileURL(join(ROOT, 'lib', 'keeper.mjs')).href);
let pass = 0, fail = 0; const out = [];
const ok = (n, c, d = '') => { c ? pass++ : fail++; out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <-- ' + d}`); };

// ---- 순수 함수
const NOW = Date.parse('2026-11-04T12:00:00'), BOOT = Date.parse('2026-11-04T08:00:00');
const iso = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
ok('isPendingEntry: 닫혀서 보존된 것(orphan)은 대기', K.isPendingEntry({ sid: 'a', orphan: true, boot: iso(BOOT) }, BOOT));
ok('isPendingEntry: 이전 부팅 기록은 대기', K.isPendingEntry({ sid: 'a', boot: '2026-11-03T00:50:54' }, BOOT));
ok('isPendingEntry: 이번 부팅의 정상 기록은 대기 아님(허용 오차 안)', !K.isPendingEntry({ sid: 'a', boot: iso(BOOT + 90000) }, BOOT) && !K.isPendingEntry({ sid: 'a', boot: iso(BOOT - 90000) }, BOOT));
ok('isPendingEntry: 부팅 기록이 없거나 깨지면 키퍼처럼 대기로 본다', K.isPendingEntry({ sid: 'a' }, BOOT) && K.isPendingEntry({ sid: 'a', boot: 'zzz' }, BOOT));
ok('isPendingEntry: 세션 ID 가 없으면 대기 아님', !K.isPendingEntry({ orphan: true }, BOOT) && !K.isPendingEntry(null, BOOT));
ok('bootMs: 지금 - 가동 시간', K.bootMs(1000000, 100) === 900000);

// ---- 자동 복구 대상(닫히기 직전만): 기준 시각 파일(session-keeper.cutoff) 또는 대기 기록으로 계산
ok('isAutoTarget: 기준 이후 확인된 것만 대상, 기준 없음/시각 모름은 빠뜨리지 않고 대상', K.isAutoTarget(2000, 1000) && K.isAutoTarget(1000, 1000) && !K.isAutoTarget(999, 1000) && K.isAutoTarget(5, null) && K.isAutoTarget(0, 1000));
{
  const d = join(tmpdir(), 'kauto-' + randomUUID().slice(0, 8)); mkdirSync(d, { recursive: true });
  const B = Date.parse('2026-11-10T17:46:03'), at = (min) => iso(Date.parse('2026-11-11T03:50:00') - min * 60000);
  const e = (n, seen) => ({ addr: 't' + n, sid: randomUUID(), orphan: true, boot: iso(B), seen, where: 'w' + n });
  const m = { t1: e(1, at(0)), t2: e(2, at(4)), t3: e(3, at(40)), t4: e(4, at(3000)) };
  writeFileSync(join(d, 'session-map.json'), JSON.stringify(m));
  let ix = K.keeperIndex(join(d, 'session-map.json'), B);
  const autos = (ix) => ['t1', 't2', 't3', 't4'].map((a) => ix.get(m[a].sid).auto);
  ok('keeperIndex: 기준 파일이 없으면 대기 기록의 가장 늦은 시각-10분으로 계산(t1·t2 대상, t3·t4 제외)', autos(ix).join() === 'true,true,false,false', autos(ix).join());
  writeFileSync(join(d, 'session-keeper.cutoff'), at(60));   // 키퍼가 적어 둔 기준(1시간 전)이면 그것을 따른다
  ix = K.keeperIndex(join(d, 'session-map.json'), B);
  ok('keeperIndex: 키퍼가 적은 기준 시각 파일을 우선 사용(t1·t2·t3 대상, t4 제외)', autos(ix).join() === 'true,true,true,false', autos(ix).join());
  writeFileSync(join(d, 'session-keeper.cutoff'), '쓰레기');
  ix = K.keeperIndex(join(d, 'session-map.json'), B);
  ok('keeperIndex: 기준 파일이 깨졌으면 무시하고 직접 계산', autos(ix).join() === 'true,true,false,false', autos(ix).join());
  const dr = K.decorateKeeper([{ sid: m.t4.sid, live: false }, { sid: m.t1.sid, live: false }], ix);
  ok('decorateKeeper: 행의 keeper.auto 로 전달', dr[0].keeper.auto === false && dr[1].keeper.auto === true);
  rmSync(d, { recursive: true, force: true });
}

const L1 = K.parseLastRestore('\uFEFF세션 자동 복구 결과\r\n작성: 2026-11-03 17:33:42 / 부팅: x\r\n판정: 정상 - 전부 복구됨(또는 이미 실행 중)\r\n집계: 대상 24개 = 성공 24 / 실패 0\r\n');
ok('parseLastRestore: BOM·CRLF·정상 판정', L1?.level === 'ok' && L1.at === '2026-11-03 17:33' && /^정상/.test(L1.verdict) && /대상 24개/.test(L1.tally), JSON.stringify(L1));
ok('parseLastRestore: 복구할 것 없음 / 주의 / 확인 필요 단계 구분',
  K.parseLastRestore('판정: 복구할 것 없음\n')?.level === 'none' && K.parseLastRestore('판정: 주의 - 확인이 필요한 창 3 개\n')?.level === 'warn' && K.parseLastRestore('판정: 확인 필요 - 재부팅 직후인데\n')?.level === 'bad' && K.parseLastRestore('판정: 이상한 말\n')?.level === 'unknown');
ok('parseLastRestore: 판정 줄이 없거나 빈 입력이면 null', K.parseLastRestore('아무 글') === null && K.parseLastRestore('') === null && K.parseLastRestore(null) === null);

const cd = 'C:\\k';
const cmdText = (c) => c.args[c.args.length - 1];
ok('keeperCommand: 전부 복구 / 창 하나 복구 / 제외 명령 모양(복구는 Start-Process 로 백그라운드)', /^Start-Process -FilePath powershell\.exe -ArgumentList '.*-File "C:\\k\\session-keeper\.ps1" -Mode Recover' -WindowStyle Hidden$/.test(cmdText(K.keeperCommand('recover', 'all', cd))) && /-Mode Recover -Only t3z' -WindowStyle Hidden$/.test(cmdText(K.keeperCommand('recover', 't3z', cd))) && K.keeperCommand('recover', 'all', cd).background === true && K.keeperCommand('forget', 'ABCDEF12', cd).args.slice(-2).join() === '-Sid,abcdef12' && !K.keeperCommand('forget', 'ABCDEF12', cd).background);
ok('keeperCommand: 이상한 입력은 거부(명령 끼워 넣기 방지)', ['x;rm', 't3 -Mode Run', 't3"', '', 'T3|', '../t3'].every((a) => K.keeperCommand('recover', a, cd).error) && ['abc', 'a b c d e f', 'xyz123', 'abcdef;calc', ''].every((a) => K.keeperCommand('forget', a, cd).error) && K.keeperCommand('nope', 'x', cd).error);

const pc = K.keeperCommand('plan', '', cd, "C:\\t\\o'k.txt");
ok('keeperCommand: 미리보기는 -Mode Recover -Plan 을 Start-Process 로 띄우고 출력을 결과 파일로(경로의 작은따옴표는 이스케이프)', /-Mode Recover -Plan' -WindowStyle Hidden -RedirectStandardOutput 'C:\\t\\o''k\.txt'$/.test(cmdText(pc)) && !!K.keeperCommand('plan', '', cd).error && !!K.keeperCommand('recover', 'all', 'C:\\bad"dir').error, cmdText(pc));
const planText = ['2026-11-04 02:34:06 TYPE t1    rh-a / ta                      cb7542a0  -> 빈 셸, 입력 가능', '2026-11-04 02:34:06 CREATE t3    작업공간 / 탭 3                f79b2a86  -> 창이 끝나 있음 - 새 탭 생성', '2026-11-04 02:34:06 SKIP t4    프로젝트 / X                   0a1b2c3d  -> 시도 3회 초과', '2026-11-04 02:34:07 복구 라운드: 대기 3 / 실행 예정 2 / 나중에 재시도 0 / 건너뜀 1  (모드: 미리보기)'].join('\r\n');
const pp = K.parsePlan(planText);
ok('parsePlan: 항목 줄(TYPE/CREATE/SKIP)과 끝 표시를 읽는다', pp.done && pp.items.length === 3 && pp.items[0].action === 'TYPE' && pp.items[0].addr === 't1' && pp.items[0].where === 'rh-a / ta' && pp.items[0].sid8 === 'cb7542a0' && pp.items[1].where === '작업공간 / 탭 3' && pp.items[2].action === 'SKIP' && pp.items[2].reason === '시도 3회 초과', JSON.stringify(pp));
ok('parsePlan: 끝 줄이 아직 없으면 done=false, 빈 입력·쓰레기 줄은 안전', K.parsePlan(planText.split('\r\n').slice(0, 2).join('\n')).done === false && K.parsePlan('').items.length === 0 && K.parsePlan(null).done === false && K.parsePlan('엉뚱한 글\n\n').items.length === 0);

// ---- 가짜 환경 만들기
const base = join(tmpdir(), 'session-keeper-kt-' + Date.now());
const fake = join(base, 'appdata'), fakeHome = join(base, 'home'), kdir = join(base, 'kdir'), codexDir = join(base, 'codex');
const proj = join(fake, 'claude-code', 'projects', 'P1');
for (const d of [proj, join(fake, 'claude-code', 'sessions'), fakeHome, kdir, codexDir]) mkdirSync(d, { recursive: true });
const hook = (sid) => JSON.stringify({ type: 'attachment', sessionId: sid, content: 'x'.repeat(200) }) + '\n';
const transcript = (sid, title) => Array.from({ length: 120 }, () => hook(sid)).join('') + JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: sid }) + '\n' + JSON.stringify({ type: 'last-prompt', lastPrompt: '질문', sessionId: sid }) + '\n' + JSON.stringify({ cwd: 'C:\\Users\\PC' }) + '\n';
const run = (args, env = {}) => spawnSync('node', [TOOL, ...args], { encoding: 'utf8', timeout: 90000, maxBuffer: 1 << 26, env: { ...process.env, APPDATA: fake, USERPROFILE: fakeHome, CODEX_HOME: codexDir, SESSIONS_NO_HERDR: '1', SESSIONS_KEEPER_DIR: kdir, ...env } });
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

try {
  const curBoot = iso(Date.now() - uptime() * 1000);
  const sid = Object.fromEntries(['orphan', 'oldboot', 'current', 'gone', 'codexOld', 'codexMissing'].map((k) => [k, randomUUID()]));
  writeFileSync(join(proj, sid.orphan + '.jsonl'), transcript(sid.orphan, '닫힌 탭의 작업'));
  writeFileSync(join(proj, sid.oldboot + '.jsonl'), transcript(sid.oldboot, '재부팅 전 작업'));
  writeFileSync(join(proj, sid.current + '.jsonl'), transcript(sid.current, '이번 부팅에서 막 끝낸 작업'));
  // 키퍼 지도: orphan(닫힘) / 이전 부팅 / 이번 부팅 정상 / 대화 파일이 없는 것 / 오래된 Codex 스레드 / 기록 없는 Codex
  const ent = (addr, s, extra) => ({ addr, where: `작업공간 / 탭${addr}`, space: '작업공간', tab: `탭${addr}`, sid: s, cwd: 'C:\\Users\\PC', boot: curBoot, seen: '2026-11-04T01:00:00', attempts: 0, orphan: false, ...extra });
  const map = {
    t1: ent('t1', sid.orphan, { orphan: true }), t2: ent('t2', sid.oldboot, { boot: '2000-01-01T00:00:00', attempts: 3 }), t3: ent('t3', sid.current, {}),
    t4: ent('t4', sid.gone, { orphan: true }), t5: ent('t5', sid.codexOld, { orphan: true, tool: 'codex' }), t6: ent('t6', sid.codexMissing, { orphan: true, tool: 'codex' }),
  };
  writeFileSync(join(kdir, 'session-map.json'), JSON.stringify(map));
  writeFileSync(join(kdir, 'LAST-RESTORE.txt'), '\uFEFF세션 자동 복구 결과\r\n작성: 2026-11-04 09:10:11 / 부팅: x\r\n판정: 주의 - 확인이 필요한 창 2 개\r\n집계: 대상 6개 = 성공 4 / 실패 2\r\n');
  // 오래된(400일 전) Codex 스레드: 기본 14일 목록 밖이어도 복구 대기에 있으면 나와야 한다
  const emit = process.emitWarning; process.emitWarning = () => {};
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite'); process.emitWarning = emit;
  const db = new DatabaseSync(join(codexDir, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, updated_at INTEGER, title TEXT, cwd TEXT, model TEXT, first_user_message TEXT, archived INTEGER)');
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?)').run(sid.codexOld, Math.floor(Date.now() / 1000) - 400 * 86400, '오래된 코덱스 작업', 'C:\\Users\\PC', 'gpt-6', '시작 질문', 0);
  db.close();

  const idx = K.keeperIndex(join(kdir, 'session-map.json'));
  ok('keeperIndex: 항목을 읽고 대기 여부·도구 종류를 계산', idx.size === 6 && idx.get(sid.orphan).pending && idx.get(sid.oldboot).pending && !idx.get(sid.current).pending && idx.get(sid.codexOld).tool === 'codex' && idx.get(sid.oldboot).attempts === 3);
  writeFileSync(join(base, 'garbage.json'), '{깨짐');
  ok('keeperIndex: 깨진·없는 지도 파일은 빈 Map(충돌 없음)', K.keeperIndex(join(base, 'garbage.json')).size === 0 && K.keeperIndex(join(base, 'nope.json')).size === 0);

  // ---- json: 키퍼 정보가 행에 붙는다
  const r = run(['json']);
  ok('json: 종료코드 0 · 올바른 JSON', r.status === 0 && Array.isArray(parse(r.stdout)), `code=${r.status} err=${r.stderr.slice(0, 200)}`);
  const rows = parse(r.stdout) || [], by = Object.fromEntries(rows.map((x) => [x.sid, x]));
  ok('json: 닫힌 창(orphan)·이전 부팅 기록은 keeper.pending, 공간/탭 이름이 붙음', by[sid.orphan]?.keeper?.pending === true && by[sid.orphan].keeper.space === '작업공간' && by[sid.orphan].keeper.tab === `탭t1` && by[sid.oldboot]?.keeper?.pending === true && by[sid.oldboot].keeper.attempts === 3, JSON.stringify(by[sid.orphan]?.keeper));
  ok('json: 이번 부팅의 정상 기록은 대기가 아님', by[sid.current]?.keeper?.pending === false);
  ok('json: 대화 파일이 없는 복구 대기(Claude)는 "복구 불가" 빈 행으로 표시(조용히 사라지지 않음)', by[sid.gone]?.missing === true && by[sid.gone].keeper.pending === true && by[sid.gone].ai === 'Claude Code', JSON.stringify(by[sid.gone]));
  ok('json: 14일이 지난 Codex 스레드도 복구 대기에 있으면 포함', by[sid.codexOld]?.ai === 'Codex' && by[sid.codexOld].keeper?.pending === true && !by[sid.codexOld].missing, JSON.stringify(by[sid.codexOld]));
  ok('json: 기록 없는 Codex 대기는 "복구 불가" 빈 행(Codex)', by[sid.codexMissing]?.missing === true && by[sid.codexMissing].ai === 'Codex');
  const plain = rows.filter((x) => !x.keeper);
  ok('json: 키퍼 기록이 없는 행에는 keeper 필드가 없다(기존 모양 유지)', plain.every((x) => !('keeper' in x)));

  // ---- last
  const l = parse(run(['last']).stdout);
  ok('last: 마지막 복구 결과 JSON', l?.level === 'warn' && l.at === '2026-11-04 09:10' && /주의/.test(l.verdict) && /대상 6개/.test(l.tally), JSON.stringify(l));
  rmSync(join(kdir, 'LAST-RESTORE.txt'));
  ok('last: 파일이 없으면 null', run(['last']).stdout === 'null');

  // ---- recover (명령만 확인)
  const dry = { SESSIONS_KEEPER_DRYRUN: '1' };
  const ra = parse(run(['recover', 'all', '--json'], dry).stdout), rt = parse(run(['recover', 't7', '--json'], dry).stdout);
  ok('recover all: 키퍼 -Mode Recover 를 Start-Process 로 띄우는 명령을 만든다(이 시험에서는 실행하지 않음)', ra?.ok && /-Mode Recover' -WindowStyle Hidden$/.test(ra.message) && ra.message.includes(join(kdir, 'session-keeper.ps1')), ra?.message);
  ok('recover <창>: -Only 로 그 창만', rt?.ok && /-Mode Recover -Only t7' -WindowStyle Hidden$/.test(rt.message), rt?.message);
  const bad = run(['recover', 'x;calc', '--json'], dry);
  ok('recover: 이상한 창 주소는 거부(종료코드 2)', bad.status === 2, `code=${bad.status}`);

  // ---- plan (미리보기): 시작은 명령만 확인, 읽기는 가짜 결과 파일로
  const planFile = join(base, 'plan.txt');
  const pst = parse(run(['plan', 'start', '--json'], { ...dry, SESSIONS_PLAN_FILE: planFile }).stdout);
  ok('plan start: 키퍼 -Mode Recover -Plan 명령을 만든다(이 시험에서는 실행하지 않음)', /^DRYRUN/.test(pst?.message || '') && /-Mode Recover -Plan' -WindowStyle Hidden -RedirectStandardOutput/.test(pst.message) && pst.message.includes(planFile.replace(/'/g, "''")), JSON.stringify(pst));
  const pr0 = parse(run(['plan', 'read'], { SESSIONS_PLAN_FILE: planFile }).stdout);
  ok('plan read: 결과 파일이 아직 없으면 done=false·빈 목록', pr0?.done === false && pr0.items.length === 0, JSON.stringify(pr0));
  writeFileSync(planFile, planText);
  const pr1 = parse(run(['plan', 'read'], { SESSIONS_PLAN_FILE: planFile }).stdout);
  ok('plan read: 결과 파일의 항목을 JSON 으로', pr1?.done === true && pr1.items.length === 3 && pr1.items[1].action === 'CREATE', JSON.stringify(pr1));
  ok('plan: 알 수 없는 하위 명령은 종료코드 2', run(['plan', 'zzz']).status === 2);

  // ---- forget (임시 폴더의 키퍼 스크립트 복사본을 진짜로 실행)
  copyFileSync(join(ROOT, 'session-keeper.ps1'), join(kdir, 'session-keeper.ps1'));
  const before = Object.keys(JSON.parse(readFileSync(join(kdir, 'session-map.json'), 'utf8')));
  const fg = run(['forget', sid.orphan, '--json']);
  const fgo = parse(fg.stdout);
  const after = JSON.parse(readFileSync(join(kdir, 'session-map.json'), 'utf8'));
  ok('forget: 그 세션만 지도에서 빠지고 나머지는 그대로', fgo?.ok === true && !Object.values(after).some((e) => e.sid === sid.orphan) && Object.keys(after).length === before.length - 1 && Object.values(after).some((e) => e.sid === sid.oldboot), `${fg.stdout} ${fg.stderr.slice(0, 200)} before=${before.length} after=${Object.keys(after).length}`);
  ok('forget: 대화 기록(.jsonl)은 지우지 않는다', readFileSync(join(proj, sid.orphan + '.jsonl')).length > 0);
  const fg2 = run(['forget', sid.orphan, '--json']);
  ok('forget: 이미 빠진 세션은 실패로 알림(종료코드 1)', fg2.status === 1 && parse(fg2.stdout)?.ok === false, fg2.stdout);
  ok('forget: 잘못된 ID 는 거부(종료코드 2)', run(['forget', 'x;y']).status === 2);

  // ---- forget-old (옛 항목 일괄 제외): 임시 키퍼 폴더에서 진짜로 실행. "닫히기 직전" 항목은 남고 옛 항목만 빠지며, 백업을 먼저 만든다.
  {
    const kd3 = join(base, 'kdir3'); mkdirSync(kd3, { recursive: true });
    copyFileSync(join(ROOT, 'session-keeper.ps1'), join(kd3, 'session-keeper.ps1'));
    const now0 = Date.parse('2026-11-10T21:55:00'); const at = (min) => iso(now0 - min * 60000);
    const mk = (a, seen) => ({ addr: a, where: `공간 / ${a}`, space: '공간', tab: a, sid: randomUUID(), cwd: 'C:\\Users\\PC', boot: '2000-01-01T00:00:00', seen, attempts: 0, orphan: true });
    const ents = { t1: mk('t1', at(0)), t2: mk('t2', at(5)), t3: mk('t3', at(60)), t4: mk('t4', at(4000)) };
    writeFileSync(join(kd3, 'session-map.json'), JSON.stringify(ents));
    for (const k of ['t3', 't4']) writeFileSync(join(proj, ents[k].sid + '.jsonl'), transcript(ents[k].sid, '옛 항목 ' + k));
    const env3 = { SESSIONS_KEEPER_DIR: kd3 };
    const dry3 = parse(run(['forget-old', '--json'], { ...env3, SESSIONS_KEEPER_DRYRUN: '1' }).stdout);
    ok('forget-old(미리보기): 키퍼 -Mode Forget -Stale 명령을 만든다', /^DRYRUN/.test(dry3?.message || '') && /-Mode Forget -Stale/.test(dry3.message), JSON.stringify(dry3));
    const fo = run(['forget-old', '--json'], env3); const foo = parse(fo.stdout);
    const m3 = JSON.parse(readFileSync(join(kd3, 'session-map.json'), 'utf8'));
    ok('forget-old: 옛 항목(t3·t4)만 빠지고 닫히기 직전 항목(t1·t2)은 남는다', foo?.ok === true && !m3.t3 && !m3.t4 && !!m3.t1 && !!m3.t2, `${fo.stdout} ${fo.stderr.slice(0, 200)} left=${Object.keys(m3)}`);
    const baks = readdirSync(kd3).filter((n) => n.startsWith('session-map.json.before-forget-old-'));
    ok('forget-old: 지우기 전 백업이 만들어지고 4개 항목이 모두 들어 있다', baks.length === 1 && Object.keys(JSON.parse(readFileSync(join(kd3, baks[0]), 'utf8'))).length === 4, baks.join());
    ok('forget-old: 대화 기록(.jsonl)은 지우지 않는다', ['t3', 't4'].every((k) => existsSync(join(proj, ents[k].sid + '.jsonl'))));
    const fo2 = run(['forget-old', '--json'], env3);
    ok('forget-old: 더 뺄 옛 항목이 없으면 실패(종료코드 1)로 알리고 아무것도 바꾸지 않는다', fo2.status === 1 && parse(fo2.stdout)?.ok === false && Object.keys(JSON.parse(readFileSync(join(kd3, 'session-map.json'), 'utf8'))).length === 2, fo2.stdout);
  }

  // ---- 백그라운드 실행이 "정말로 일을 하는지"(명령 모양만 보면 놓치는 결함: 분리(detached) 실행한 PowerShell 은 0.6초 만에 아무 일도 안 하고 끝났다)
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 500)); } return fn(); };
  const kd2 = join(base, 'kdir2');
  mkdirSync(kd2, { recursive: true });
  copyFileSync(join(ROOT, 'session-keeper.ps1'), join(kd2, 'session-keeper.ps1'));
  writeFileSync(join(kd2, 'session-map.json'), '{}');                  // 복구할 것이 없는 빈 지도 -> Herdr 를 건드리지 않고, 키퍼가 돌았다는 흔적(결과 파일)만 남는다
  const planFile2 = join(kd2, 'plan.txt');
  const real = { SESSIONS_KEEPER_DIR: kd2, SESSIONS_PLAN_FILE: planFile2 };
  const rr = parse(run(['recover', 'all', '--json'], real).stdout);
  ok('recover all(실제 실행): 백그라운드로 뜬 키퍼가 돌아 LAST-RESTORE.txt 를 쓴다', rr?.ok === true && await waitFor(() => existsSync(join(kd2, 'LAST-RESTORE.txt')), 30000), JSON.stringify(rr));
  const ps = parse(run(['plan', 'start', '--json'], real).stdout);
  ok('plan start(실제 실행): 백그라운드로 뜬 키퍼가 돌아 결과 파일을 만든다', ps?.ok === true && await waitFor(() => existsSync(planFile2), 30000), JSON.stringify(ps));
  await new Promise((r) => setTimeout(r, 3000));                        // 뜬 키퍼가 끝나고 파일을 놓을 시간
} finally {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* 임시 폴더 정리 실패는 무시 */ }
}

// ---- Herdr 앱 업데이트 상태·명령 (임시 폴더)
{
  const ud = join(base, 'appupd'); mkdirSync(ud, { recursive: true });
  const stamp = (msAgo) => iso(Date.now() - msAgo);                       // 키퍼처럼 "지역 시각"(yyyy-MM-ddTHH:mm:ss)으로 적는다
  ok('readAppUpdate: 파일이 없으면 none + 자동 켜짐', (() => { const s = K.readAppUpdate(ud); return s.kind === 'none' && s.auto === true; })());
  writeFileSync(join(ud, 'session-keeper.appupdate.json'), JSON.stringify({ kind: 'ready', installed: '0.1.14', staged: '0.1.15', checkedAt: stamp(60000) }));
  ok('readAppUpdate: 최근 상태(ready)를 읽는다', (() => { const s = K.readAppUpdate(ud); return s.kind === 'ready' && s.installed === '0.1.14' && s.staged === '0.1.15'; })());
  writeFileSync(join(ud, 'session-keeper.appupdate.json'), JSON.stringify({ kind: 'ready', installed: '0.1.14', staged: '0.1.15', checkedAt: stamp(3 * 3600000) }));
  ok('readAppUpdate: 키퍼가 20분 넘게 갱신하지 않은 낡은 상태는 none', K.readAppUpdate(ud).kind === 'none');
  writeFileSync(join(ud, 'session-keeper.appupdate.json'), '쓰레기{');
  ok('readAppUpdate: 깨진 파일도 예외 없이 none', K.readAppUpdate(ud).kind === 'none');
  writeFileSync(join(ud, 'session-keeper.appupdate.off'), 'x');
  ok('readAppUpdate: .off 파일이 있으면 자동 꺼짐', K.readAppUpdate(ud).auto === false);
  const cu = K.keeperCommand('update', '', ROOT);
  ok('keeperCommand(update): 백그라운드로 -Mode Update', cu.background === true && /-Mode Update/.test(cu.args.join(' ')));
  const ca = K.keeperCommand('update-auto', 'Off', ROOT);
  ok('keeperCommand(update-auto): -Mode Update -Auto Off', /-Mode.*Update.*-Auto.*Off/.test(ca.args.join(' ')));
  ok('keeperCommand(update-auto): On/Off 외의 값은 거절(명령줄 주입 방지)', !!K.keeperCommand('update-auto', 'On; calc', ROOT).error && !!K.keeperCommand('update-auto', '', ROOT).error);
  const r1 = spawnSync(process.execPath, [TOOL, 'update', '--json'], { encoding: 'utf8', env: { ...process.env, SESSIONS_KEEPER_DIR: ud, SESSIONS_NO_HERDR: '1', SESSIONS_KEEPER_DRYRUN: '1' } });
  ok('sessions.mjs update: 적용할 업데이트가 없으면(상태 낡음/none) 키퍼를 부르지 않고 거절', r1.status === 1 && /적용할 앱 업데이트가 없습니다/.test(r1.stdout));
  writeFileSync(join(ud, 'session-keeper.appupdate.json'), JSON.stringify({ kind: 'ready', installed: '0.1.14', staged: '0.1.15', checkedAt: stamp(1000) }));
  const r2 = spawnSync(process.execPath, [TOOL, 'update', '--json'], { encoding: 'utf8', env: { ...process.env, SESSIONS_KEEPER_DIR: ud, SESSIONS_NO_HERDR: '1', SESSIONS_KEEPER_DRYRUN: '1' } });
  ok('sessions.mjs update: 대기 중이면 키퍼 -Mode Update 명령을 만든다(DRYRUN)', r2.status === 0 && /DRYRUN/.test(r2.stdout) && /-Mode Update/.test(r2.stdout));
  const r3 = spawnSync(process.execPath, [TOOL, 'update-auto', 'maybe', '--json'], { encoding: 'utf8', env: { ...process.env, SESSIONS_KEEPER_DIR: ud, SESSIONS_NO_HERDR: '1', SESSIONS_KEEPER_DRYRUN: '1' } });
  ok('sessions.mjs update-auto: on/off 외의 값은 사용법 오류(종료 2)', r3.status === 2);
  const r4 = spawnSync(process.execPath, [TOOL, 'update-auto', 'off', '--json'], { encoding: 'utf8', env: { ...process.env, SESSIONS_KEEPER_DIR: ud, SESSIONS_NO_HERDR: '1', SESSIONS_KEEPER_DRYRUN: '1' } });
  ok('sessions.mjs update-auto off: 명령을 만든다(DRYRUN)', r4.status === 0 && /-Auto Off/.test(r4.stdout));
  try { rmSync(base, { recursive: true, force: true }); } catch { /* 임시 폴더 정리 실패는 무시 */ }
}

console.log(out.join('\n'));
console.log(`\n합계: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
