// sessions.mjs 견고성 시험: 가짜 APPDATA(임시 폴더)에 비정상 데이터를 만들어 돌린다.
// 실제 세션·설정은 읽지도 쓰지도 않는다. (sessions.mjs 는 APPDATA/USERPROFILE 환경변수로 데이터 위치를 읽는다.)
import { spawnSync } from 'node:child_process';
delete process.env.CLAUDE_CONFIG_DIR;   // 이 시험은 가짜 APPDATA 로 Claude 데이터 위치를 격리한다. 개발 PC 가 CLAUDE_CONFIG_DIR 을 지정해도 실제 폴더를 읽지 않게 한다
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'sessions.mjs');
const base = join(tmpdir(), 'session-keeper-fixture-' + Date.now());
const fake = join(base, 'appdata');
const fakeHome = join(base, 'home');            // Codex 기록 위치(~/.codex)도 가짜로 돌린다
const sess = join(fake, 'claude-code', 'sessions'), proj = join(fake, 'claude-code', 'projects');
mkdirSync(sess, { recursive: true }); mkdirSync(join(proj, 'P1'), { recursive: true }); mkdirSync(join(proj, 'EMPTYDIR'), { recursive: true }); mkdirSync(fakeHome, { recursive: true });
let pass = 0, fail = 0; const out = [];
const ok = (n, c, d = '') => { c ? pass++ : fail++; out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <-- ' + d}`); };
// Herdr(hc)·프로세스 조회는 끄고(SESSIONS_NO_HERDR), Codex 데이터 폴더도 가짜로 돌려 실제 데이터를 읽지 않는다.
const run = (args, env = {}) => spawnSync('node', [TOOL, ...args], { encoding: 'utf8', timeout: 90000, maxBuffer: 1 << 26, env: { ...process.env, APPDATA: fake, USERPROFILE: fakeHome, CODEX_HOME: join(base, 'no-codex'), SESSIONS_NO_HERDR: '1', SESSIONS_KEEPER_DIR: join(base, 'no-keeper'), ...env } });   // 키퍼 기록도 가짜(없는 폴더)로
const hookLine = (sid) => JSON.stringify({ type: 'attachment', sessionId: sid, content: 'x'.repeat(200) }) + '\n';
const padHooks = (sid, n) => { let s = ''; for (let i = 0; i < n; i++) s += hookLine(sid); return s; };

try {
  const ids = Object.fromEntries(['zero', 'garbage', 'normal', 'unicode', 'escapes', 'fresh', 'bigline'].map((k) => [k, randomUUID()]));
  writeFileSync(join(proj, 'P1', ids.zero + '.jsonl'), '');                                                    // 0바이트
  writeFileSync(join(proj, 'P1', ids.garbage + '.jsonl'), randomBytes(40 * 1024));                             // 완전한 쓰레기 바이너리
  writeFileSync(join(proj, 'P1', ids.normal + '.jsonl'), padHooks(ids.normal, 120) + JSON.stringify({ type: 'ai-title', aiTitle: '정상 제목', sessionId: ids.normal }) + '\n' + JSON.stringify({ type: 'last-prompt', lastPrompt: '마지막 질문입니다', sessionId: ids.normal }) + '\n' + JSON.stringify({ message: { model: 'claude-opus-4-1-20250805' }, cwd: 'C:\\Users\\PC' }) + '\n');
  writeFileSync(join(proj, 'P1', ids.unicode + '.jsonl'), padHooks(ids.unicode, 120) + JSON.stringify({ type: 'ai-title', aiTitle: '이모지 😀 한글 ✔ テスト', sessionId: ids.unicode }) + '\n' + JSON.stringify({ type: 'last-prompt', lastPrompt: 'a'.repeat(5000), sessionId: ids.unicode }) + '\n');
  writeFileSync(join(proj, 'P1', ids.escapes + '.jsonl'), padHooks(ids.escapes, 120) + '{"type":"ai-title","aiTitle":"따옴표 \\"안\\" 역슬래시 C:\\\\Users\\\\x 줄바꿈\\n끝","sessionId":"' + ids.escapes + '"}\n{"type":"last-prompt","lastPrompt":"q","sessionId":"' + ids.escapes + '"}\n');
  writeFileSync(join(proj, 'P1', ids.bigline + '.jsonl'), '{"type":"x","blob":"' + 'z'.repeat(3 * 1024 * 1024) + '"}\n{"type":"ai-title","aiTitle":"큰 줄 뒤 제목","sessionId":"' + ids.bigline + '"}\n');   // 3MB 한 줄
  writeFileSync(join(proj, 'P1', 'not-a-uuid.jsonl'), padHooks('x', 120));                                      // 이름이 UUID 가 아님
  mkdirSync(join(proj, 'P1', randomUUID() + '.jsonl'), { recursive: true });                                    // jsonl 이름의 폴더
  // 실행 중으로 보이는 세션: 이 시험 프로세스(pid)를 빌려 쓴다. cli(사용자가 연 것) / sdk-cli(자동 도우미)
  writeFileSync(join(sess, 'bad.json'), '{not json');                                                           // 깨진 세션 파일
  writeFileSync(join(sess, 'empty.json'), '');
  writeFileSync(join(sess, 'dead.json'), JSON.stringify({ pid: 4000000, sessionId: randomUUID(), cwd: 'C:\\x', entrypoint: 'cli' }));   // 없는 pid
  writeFileSync(join(proj, 'P1', ids.fresh + '.jsonl'), padHooks(ids.fresh, 120));                              // 질문·제목이 아직 없는 새 세션
  writeFileSync(join(sess, 'fresh.json'), JSON.stringify({ pid: process.pid, sessionId: ids.fresh, cwd: 'C:\\Users\\PC', entrypoint: 'cli', kind: 'interactive' }));
  const helper = randomUUID();
  writeFileSync(join(proj, 'P1', helper + '.jsonl'), padHooks(helper, 120) + '{"type":"last-prompt","lastPrompt":"Below is a conversation log from a Claude Code session","sessionId":"' + helper + '"}\n');
  writeFileSync(join(sess, 'helper.json'), JSON.stringify({ pid: process.pid, sessionId: helper, cwd: 'C:\\Users\\PC', entrypoint: 'sdk-cli', kind: 'interactive' }));

  const r = run(['json', '--days', '30', '--limit', '60']);
  ok('비정상 데이터에서도 종료코드 0 (충돌 없음)', r.status === 0, `code=${r.status} err=${r.stderr.slice(0, 200)}`);
  let rows = []; try { rows = JSON.parse(r.stdout); ok('출력이 올바른 JSON', Array.isArray(rows)); } catch (e) { ok('출력이 올바른 JSON', false, r.stdout.slice(0, 100)); }
  const by = Object.fromEntries(rows.map((x) => [x.sid, x]));
  ok('정상 파일: 제목·마지막 질문·모델(Opus 4.1)·폴더 추출', by[ids.normal]?.title === '정상 제목' && by[ids.normal]?.lastPrompt === '마지막 질문입니다' && by[ids.normal]?.model === 'Opus 4.1' && by[ids.normal]?.cwd === 'C:\\Users\\PC', JSON.stringify(by[ids.normal]));
  ok('이모지·한글·일본어 제목이 깨지지 않음', by[ids.unicode]?.title === '이모지 😀 한글 ✔ テスト', by[ids.unicode]?.title);
  ok('긴 질문(5000자)은 120자로 잘림', (by[ids.unicode]?.lastPrompt || '').length === 120, String((by[ids.unicode]?.lastPrompt || '').length));
  ok('따옴표·역슬래시·줄바꿈이 든 제목이 정확히 복원', by[ids.escapes]?.title === '따옴표 "안" 역슬래시 C:\\Users\\x 줄바꿈\n끝', JSON.stringify(by[ids.escapes]?.title));
  ok('0바이트·쓰레기 바이너리·UUID 아닌 이름은 목록에 없고 충돌도 없음', !by[ids.zero] && !by[ids.garbage] && !rows.some((x) => x.sid === 'not-a-uuid'));
  ok('죽은 pid(4000000)·깨진/빈 세션 파일은 무시', !rows.some((x) => x.live && x.cwd === 'C:\\x'));
  ok('자동 도우미(sdk-cli) 세션은 기본에서 숨김', !by[helper], JSON.stringify(by[helper]));
  ok('사용자가 방금 연 실행 중 세션(cli, 아직 질문 없음)은 숨기면 안 됨', !!by[ids.fresh]?.live, `by[fresh]=${JSON.stringify(by[ids.fresh])}`);
  const ra = run(['json', '--all', '--days', '30', '--limit', '60']); let rowsAll = []; try { rowsAll = JSON.parse(ra.stdout); } catch { /* */ }
  ok('--all 이면 자동 도우미·빈 기록도 포함', rowsAll.some((x) => x.sid === helper) && rowsAll.some((x) => x.sid === ids.fresh), `all=${rowsAll.length}`);
  const rl = run(['list']); ok('list 표 출력도 충돌 없음', rl.status === 0, rl.stderr.slice(0, 150));
  const rn = spawnSync('node', [TOOL, 'json'], { encoding: 'utf8', env: { ...process.env, APPDATA: join(base, 'does-not-exist'), USERPROFILE: join(base, 'no-home'), CODEX_HOME: join(base, 'no-codex'), SESSIONS_NO_HERDR: '1' } });
  let nrows = null; try { nrows = JSON.parse(rn.stdout); } catch { /* */ }
  ok('세션 폴더가 아예 없어도 빈 목록 [] 으로 정상 종료', rn.status === 0 && Array.isArray(nrows), `code=${rn.status} out=${rn.stdout.slice(0, 80)} err=${rn.stderr.slice(0, 120)}`);
} finally {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* 임시 폴더 정리 실패는 무시 */ }
}
console.log(out.join('\n')); console.log(`\n합계: PASS ${pass} / FAIL ${fail}`); process.exit(fail ? 1 : 0);
