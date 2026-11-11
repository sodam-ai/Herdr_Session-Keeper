// 계약 시험: 세션키퍼가 "다른 프로그램이 만드는 파일/명령"에 기대는 부분이 아직 그 모양인지 확인한다.
// (Claude Code·Herdr·자동 복원(session-keeper.ps1)이 업데이트로 형식을 바꾸면 여기서 먼저 잡힌다. 읽기 전용, 내용은 출력하지 않는다.)
import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let pass = 0, fail = 0; const out = [];
const ok = (n, c, d = '') => { c ? pass++ : fail++; out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <-- ' + d}`); };
const note = (n) => out.push(`INFO  ${n}`);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const tail = (f, n) => { const fd = openSync(f, 'r'); try { const len = statSync(f).size, k = Math.min(n, len), b = Buffer.alloc(k); readSync(fd, b, 0, k, len - k); return b.toString('utf8'); } finally { closeSync(fd); } };

// 1) Claude Code 세션 파일: %APPDATA%\claude-code\sessions\<pid>.json
const sessDir = join(process.env.APPDATA, 'claude-code', 'sessions');
const sessFiles = existsSync(sessDir) ? readdirSync(sessDir).filter((f) => f.endsWith('.json')) : [];
const sess = sessFiles.map((f) => readJson(join(sessDir, f))).filter(Boolean);
ok('Claude 세션 파일이 있고 읽힌다', sess.length > 0, `파일 ${sessFiles.length}개 / 읽힘 ${sess.length}개`);
ok('세션 파일 필드: pid(숫자)·sessionId(UUID)·cwd(문자열)', sess.every((o) => Number.isInteger(o.pid) && UUID.test(o.sessionId) && typeof o.cwd === 'string'), JSON.stringify(sess.find((o) => !(Number.isInteger(o.pid) && UUID.test(o.sessionId)))));
ok('세션 파일 필드: entrypoint 가 있다(자동 도우미 구분에 쓰임)', sess.filter((o) => typeof o.entrypoint === 'string').length >= Math.ceil(sess.length * 0.9), `entrypoint 있음 ${sess.filter((o) => typeof o.entrypoint === 'string').length}/${sess.length}`);

// 2) 대화 기록: 제목(aiTitle)·마지막 질문(lastPrompt)·모델이 최근 기록에 실제로 들어 있는가
const projDir = join(process.env.APPDATA, 'claude-code', 'projects');
const recent = [];
for (const d of readdirSync(projDir, { withFileTypes: true })) {
  if (!d.isDirectory() || /AppData-Local-Temp-remember-|-claude-double-shot-latte$/.test(d.name)) continue;
  try { for (const f of readdirSync(join(projDir, d.name))) if (f.endsWith('.jsonl')) { const p = join(projDir, d.name, f); recent.push({ p, m: statSync(p).mtimeMs, s: statSync(p).size }); } } catch { /* 건너뜀 */ }
}
recent.sort((a, b) => b.m - a.m);
const sample = recent.filter((x) => x.s > 50 * 1024).slice(0, 25).map((x) => tail(x.p, 256 * 1024));
ok(`최근 대화 기록 ${sample.length}개 중 제목(aiTitle) 형식을 가진 것이 있다`, sample.some((t) => /"aiTitle":"/.test(t)), '형식이 바뀌었을 수 있음');
ok('최근 대화 기록 중 마지막 질문(lastPrompt) 형식을 가진 것이 있다', sample.some((t) => /"lastPrompt":"/.test(t)));
ok('최근 대화 기록 중 모델("model":"claude-…") 형식을 가진 것이 있다', sample.some((t) => /"model":"claude-[a-z0-9-]+"/.test(t)));

// 3) 자동 복원(session-keeper.ps1)이 적는 창 기록: session-map.json  (없으면 자동 복원이 아직 안 돈 것이라 건너뜀)
const mapFile = join(ROOT, 'session-map.json');
if (existsSync(mapFile)) {
  const m = readJson(mapFile);
  ok('session-map.json 이 올바른 JSON', m && typeof m === 'object', '깨진 JSON');
  const entries = Object.values(m || {});
  ok('창 기록 필드: addr(t…)·sid(UUID)·where·cwd 문자열', entries.every((e) => /^t[0-9a-z]+$/.test(e.addr) && UUID.test(e.sid) && typeof e.where === 'string' && typeof e.cwd === 'string'), JSON.stringify(entries.find((e) => !(/^t[0-9a-z]+$/.test(e.addr) && UUID.test(e.sid)))));
} else note('session-map.json 없음 — 자동 복원이 아직 기록하지 않아 이 항목은 건너뜀');

// 4) Herdr 명령: 세션키퍼가 쓰는 앱 명령과 hc 가 아직 있는가
const app = join(process.env.LOCALAPPDATA, 'Programs', 'herdr-app', 'herdr-app.exe');
if (existsSync(app)) {
  const r = spawnSync(app, ['commands'], { encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 24 });
  let names = []; try { names = JSON.parse(r.stdout).map((c) => c.name); } catch { /* */ }
  for (const need of ['terminal.open', 'agent.focus', 'mod.open', 'overlay.close', 'tab.close']) ok(`Herdr 명령 ${need} 이(가) 있다`, names.includes(need), `명령 ${names.length}개`);
} else ok('Herdr 앱 설치 위치', false, app);
{ const r = spawnSync('hc', ['--version'], { encoding: 'utf8', timeout: 20000, shell: true }); ok('hc 명령을 실행할 수 있다', r.status === 0, (r.stderr || '').slice(0, 80)); }

console.log(out.join('\n')); console.log(`\n합계: PASS ${pass} / FAIL ${fail}`); process.exit(fail ? 1 : 0);
