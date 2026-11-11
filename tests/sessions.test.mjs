// sessions.mjs 통합 시험 (실제 이 PC의 세션 데이터를 읽기만 한다).
// 읽기 전용 명령과 "거부되어야 하는 입력"만 쓴다. 실제 세션을 열거나 창을 옮기지 않는다.
import { spawnSync, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'sessions.mjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail = '') { (cond ? pass++ : fail++); results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <-- ' + detail}`); }
function run(args, timeout = 90000) {
  const t0 = Date.now();
  const r = spawnSync('node', [TOOL, ...args], { encoding: 'utf8', timeout, maxBuffer: 1 << 26 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', ms: Date.now() - t0 };
}

// 1. 정상 흐름: json
const j = run(['json']);
ok('json: 종료코드 0', j.code === 0, `code=${j.code} err=${j.err.slice(0, 120)}`);
let rows = [];
try { rows = JSON.parse(j.out); ok('json: 올바른 JSON 배열', Array.isArray(rows)); } catch (e) { ok('json: 올바른 JSON 배열', false, e.message); }
ok('json: 1개 이상', rows.length > 0, `len=${rows.length}`);
const need = ['ai', 'model', 'sid', 'short', 'title', 'lastPrompt', 'cwd', 'folder', 'mtime', 'mtimeMs', 'live', 'pid', 'addr', 'where'];
ok('json: 모든 줄에 필수 필드', rows.every((r) => need.every((k) => k in r)), JSON.stringify(rows.find((r) => !need.every((k) => k in r)) || {}).slice(0, 150));
ok('json: sid 형식(UUID) 전부 정상', rows.every((r) => UUID.test(r.sid)));
ok('json: short = sid 앞 8자', rows.every((r) => r.short === r.sid.slice(0, 8)));
ok('json: sid 중복 없음', new Set(rows.map((r) => r.sid)).size === rows.length);
ok('json: 최신순 정렬', rows.every((r, i) => i === 0 || rows[i - 1].mtimeMs >= r.mtimeMs));
ok('json: live 는 boolean, Claude 가 live면 pid 있음', rows.every((r) => typeof r.live === 'boolean' && (!r.live || r.ai !== 'Claude Code' || Number.isInteger(r.pid))));
ok('json: 제목이 비어 있지 않음', rows.every((r) => typeof r.title === 'string' && r.title.length > 0));
ok('json: 모델 이름 형식(비었거나 "이름 숫자")', rows.every((r) => r.model === '' || /^[A-Za-z][\w.-]* ?\d/.test(r.model)), JSON.stringify(rows.filter((r) => r.model && !/^[A-Za-z][\w.-]* ?\d/.test(r.model)).map((r) => r.model).slice(0, 3)));

// 2. Claude "실행 중" 판정이 운영체제 프로세스 목록과 일치하는지 (독립 확인). 자동 도우미(sdk-cli)는 숨기는 것이 설계.
const alivePids = new Set(execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).split(/\r?\n/).map((l) => (l.split('","')[1] || '').replace(/"/g, '')).filter(Boolean).map(Number));
const sessDir = join(process.env.APPDATA, 'claude-code', 'sessions');
const expectLive = new Set();
// 방금 켠 세션은 아직 대화 파일(.jsonl)이 없다. 목록은 대화 파일로 만들기 때문에 이런 세션이 빠지는 것은 설계된 동작이다(2026-11-10: 새로 연 창 5개 때문에 실패했음).
const projRoot = join(process.env.APPDATA, 'claude-code', 'projects');
const projDirs = (() => { try { return readdirSync(projRoot); } catch { return []; } })();
const hasTranscript = (sid) => projDirs.some((d) => existsSync(join(projRoot, d, sid + '.jsonl')));
for (const f of readdirSync(sessDir).filter((x) => x.endsWith('.json'))) {
  try {
    const o = JSON.parse(readFileSync(join(sessDir, f), 'utf8').replace(/^﻿/, ''));
    if (o.sessionId && alivePids.has(Number(o.pid)) && o.entrypoint !== 'sdk-cli' && hasTranscript(o.sessionId)) expectLive.add(o.sessionId);
  } catch { /* 깨진 파일은 무시 */ }
}
const gotLive = new Set(rows.filter((r) => r.live && r.ai === 'Claude Code').map((r) => r.sid));
const missing = [...expectLive].filter((s) => !gotLive.has(s)), extra = [...gotLive].filter((s) => !expectLive.has(s));
// 시험 도중 세션이 생기거나 끝날 수 있어 1개 차이까지는 시간차로 본다(0 차이가 정상)
ok(`Claude 실행 중 판정 = 프로세스 목록 (예상 ${expectLive.size} / 결과 ${gotLive.size})`, missing.length + extra.length <= 1, `빠짐=${missing.length} 초과=${extra.length}`);

// 3. list 표 출력
const l = run(['list', '--limit', '5']);
ok('list: 종료코드 0 + 요약줄', l.code === 0 && /세션 \d+개/.test(l.out), l.out.slice(0, 100));

// 4. 경계값: limit / days  (0 은 유효한 값, 음수·글자는 기본값)
for (const [label, a] of [['--limit 0', ['--limit', '0']], ['--limit 1', ['--limit', '1']], ['--limit -5', ['--limit', '-5']], ['--limit abc', ['--limit', 'abc']], ['--limit 100000', ['--limit', '100000']], ['--days 0', ['--days', '0']], ['--days -1', ['--days', '-1']], ['--days abc', ['--days', 'abc']], ['--days 3650', ['--days', '3650']]]) {
  const r = run(['json', ...a]);
  let n = -1; try { n = JSON.parse(r.out).length; } catch { /* 아래에서 실패 처리 */ }
  ok(`경계값 json ${label}: 오류 없이 JSON`, r.code === 0 && n >= 0, `code=${r.code} n=${n} err=${r.err.slice(0, 80)}`);
}
{
  const r0 = run(['json', '--limit', '0']); let rows0 = []; try { rows0 = JSON.parse(r0.out); } catch { /* */ }
  // 키퍼가 추적 중인 세션(복구 대기 Codex 등)은 설계상 --limit 과 무관하게 항상 포함되므로 "일반 꺼진 세션"에서 제외한다.
  ok('경계값 --limit 0 → 창 연결·실행 중이 아닌 일반 꺼진 세션은 0개(키퍼 추적 행 제외)', rows0.filter((x) => !x.live && !x.where && !x.keeper).length === 0, `일반 꺼진 ${rows0.filter((x) => !x.live && !x.where && !x.keeper).length}개`);
  const r1 = run(['json', '--limit', '1']); let rows1 = []; try { rows1 = JSON.parse(r1.out); } catch { /* */ }
  ok('경계값 --limit 1 → 일반 꺼진 세션은 AI 종류마다 최대 1개', ['Claude Code', 'Codex'].every((ai) => rows1.filter((x) => x.ai === ai && !x.live && !x.where && !x.keeper).length <= 1), JSON.stringify(rows1.filter((x) => !x.live && !x.where && !x.keeper).map((x) => x.ai)));
}

// 5. 잘못된 입력 (open) — 전부 거부되고 어떤 창도 열리면 안 된다
for (const [label, a, expectCode] of [
  ['open 인자 없음', ['open'], 2], ['open 빈 문자열', ['open', ''], 2], ['open 짧은 ID(abc)', ['open', 'abc'], 2],
  ['open 5자(abcde)', ['open', 'abcde'], 2], ['open 없는 접두어(ffffff)', ['open', 'ffffff'], 2],
  ['open 경로 주입(../../x)', ['open', '../../windows/system32'], 2], ['open 공백 포함', ['open', 'a b c d e f g'], 2],
  ['open 셸 문자(;calc)', ['open', 'abcdef;calc'], 2], ['open 10000자', ['open', 'a'.repeat(10000)], 2], ['open 한글', ['open', '가나다라마바사'], 2],
  ['open 36자 비UUID', ['open', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'], 2],
]) {
  const r = run(a);
  ok(`잘못된 입력: ${label} → 종료코드 ${expectCode}, 충돌 없음`, r.code === expectCode && !/at .*\.mjs:\d+/.test(r.err), `code=${r.code} err=${r.err.slice(0, 120)}`);
}
{
  const r = run(['open', '00000000-0000-4000-8000-000000000000', '--json']);
  let o = {}; try { o = JSON.parse(r.out); } catch { /* */ }
  ok('open 존재하지 않는 UUID → 거부(NO_TRANSCRIPT), 종료코드 1', r.code === 1 && o.ok === false && o.code === 'NO_TRANSCRIPT', `code=${r.code} out=${r.out.slice(0, 120)}`);
}
{
  const live = rows.find((r) => r.live && r.ai === 'Claude Code');
  if (live) {
    for (const [label, id] of [['전체 UUID', live.sid], ['앞 8자', live.short], ['대문자 UUID', live.sid.toUpperCase()]]) {
      const r = run(['open', id, '--json']); let o = {}; try { o = JSON.parse(r.out); } catch { /* */ }
      ok(`실행 중 세션 open(${label}) → ALREADY_RUNNING 으로 거부`, r.code === 1 && o.code === 'ALREADY_RUNNING', `code=${r.code} out=${r.out.slice(0, 100)} err=${r.err.slice(0, 100)}`);
    }
  } else ok('실행 중 세션 거부 시험', false, '실행 중 세션이 없어 시험 불가');
}

// 6. focus 입력 검증 (실제 창 이동은 하지 않는다)
for (const [label, a, expectCode] of [['focus 인자 없음', ['focus'], 2], ['focus 공백 주소', ['focus', 'bad addr'], 2], ['focus 셸 문자(t3z;calc)', ['focus', 't3z;calc'], 2], ['focus JSON 주입', ['focus', 't1","x":"'], 2], ['focus 없는 주소(tzzzzz)', ['focus', 'tzzzzz'], 1]]) {
  const r = run(a);
  ok(`잘못된 입력: ${label} → 종료코드 ${expectCode}`, r.code === expectCode, `code=${r.code} out=${r.out.slice(0, 80)} err=${r.err.slice(0, 80)}`);
}
{ const r = run(['nonsense']); ok('알 수 없는 명령 → 종료코드 2', r.code === 2, `code=${r.code}`); }

// 7. 성능 (환경 변동이 있어 3회 중 가장 빠른 값을 기준으로 한다)
const times = [run(['json']).ms, run(['json']).ms, run(['json']).ms];
const best = Math.min(...times);
ok(`성능: 기본 json 최고 ${best}ms (기준 4000ms 이하; 측정 ${times.join('/')}ms)`, best <= 4000);
const wide = run(['json', '--all', '--days', '60', '--limit', '400']);
ok(`성능: open 이 내부에서 쓰는 넓은 조회 ${wide.ms}ms (기준 12000ms 이하)`, wide.ms <= 12000);

// 8. 읽기 전용 확인: 도구에 파일 쓰기·삭제 호출이 없다
const toolSrc = readFileSync(TOOL, 'utf8');
ok('읽기 전용: sessions.mjs 에 파일 쓰기/삭제 호출 없음', !/writeFile|appendFile|unlink|rmSync|renameSync/.test(toolSrc));
// "전부 복구" 미리보기 결과 파일(임시 폴더)은 PowerShell 이 직접 쓴다 -> 이 도구는 파일을 쓰기로 여는 곳이 전혀 없어야 한다.
ok("쓰기로 여는 파일이 전혀 없다(openSync 'w' 없음)", !/openSync\([^)]*['"][wa]\+?['"]\)/.test(toolSrc) && !/createWriteStream/.test(toolSrc));

console.log(results.join('\n'));
console.log(`\n합계: PASS ${pass} / FAIL ${fail}   (세션 ${rows.length}개, 실행 중 ${rows.filter((r) => r.live).length}개)`);
process.exit(fail ? 1 : 0);
