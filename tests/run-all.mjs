// 세션키퍼 전체 시험 실행기:  node tests/run-all.mjs   (일부만: node tests/run-all.mjs fixtures installer)
// 각 시험 파일은 "합계: PASS n / FAIL m" 을 출력하고 실패가 있으면 종료코드 1 로 끝난다.
// 실제 세션을 열거나 Herdr 설정을 바꾸는 시험은 없다(읽기 전용 + 임시 폴더).
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const SUITES = [
  { key: 'contract', name: '계약: 다른 프로그램이 주는 파일·명령 모양', cmd: 'node', args: ['contract.test.mjs'] },
  { key: 'lib', name: '순수 함수: 창↔세션 연결·모델 이름·공용 도구', cmd: 'node', args: ['lib.test.mjs'] },
  { key: 'model', name: '창 화면 로직 (model.js)', cmd: 'node', args: ['model.test.mjs'], optional: true },
  { key: 'fixtures', name: '비정상 데이터 견고성 (가짜 데이터)', cmd: 'node', args: ['fixtures.test.mjs'] },
  { key: 'sessions', name: '목록·복구 도구 (실제 데이터, 읽기 전용)', cmd: 'node', args: ['sessions.test.mjs'] },
  { key: 'codex', name: 'Codex 세션 (가짜 SQLite)', cmd: 'node', args: ['codex.test.mjs'] },
  { key: 'keeper', name: '복구 대기: 키퍼 기록 읽기·빼기·복구 명령 (임시 폴더)', cmd: 'node', args: ['keeper.test.mjs'] },
  { key: 'edge', name: '경계·실패: 잘못된 입력·손상 파일·이상한 폴더·대량·동시 접근 (임시 폴더)', cmd: 'node', args: ['edge.test.mjs'] },
  { key: 'order', name: '복구 순서: 우선 공간 → 최근 사용순 (키퍼 함수, 읽기 전용)', cmd: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'order.test.ps1'] },
  { key: 'codexpair', name: 'Codex 창 짝짓기(명령줄 resume ID 확정)·새 탭 생성 허용 판단 (가짜 대화 파일, 임시 폴더)', cmd: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'codexpair.test.ps1'] },
  { key: 'autostart', name: '자동 시작 규칙: 부팅만으로는 안 켜짐, Herdr 앱이 켜져 있을 때만 키퍼 동작 (감시 스크립트 + 임시 사본)', cmd: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'autostart.test.ps1'] },
  { key: 'closeverdict', name: '직접 닫은 창은 복구 목록에서 제외 + 자동 복구는 닫히기 직전 창만 (판정 함수, 실제 기록은 읽기 전용)', cmd: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'closeverdict.test.ps1'] },
  { key: 'readme', name: 'README 4종: 한·영 구조 동일, 목차 링크, md 글자 = html 글자', cmd: 'node', args: ['readme.test.mjs'] },
  { key: 'kit', name: '설치 꾸러미: 마켓플레이스·플러그인 생성 + 설치/재설치/충돌 거부/제거 (임시 폴더·임시 작업, 한글·공백 경로)', cmd: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'kit.test.ps1'] },
  { key: 'appupdate', name: 'Herdr 앱 업데이트: 폴더 잠김 재현 + 파일 교체·창 재시작·중간 실패 원복 (가짜 exe, 임시 폴더)', cmd: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'appupdate.test.ps1'] },
  { key: 'monitorloss', name: '복구 결과 요약: 대화만 복구되고 감시·예약이 꺼진 창 알림 (가짜 대화 파일, 임시 폴더)', cmd: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'monitorloss.test.ps1'] },
  { key: 'cleanup', name: '폐기 파일 정리 스크립트 (임시 폴더)', cmd: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'cleanup.test.ps1'] },
  { key: 'installer', name: '설치 스크립트 (임시 폴더)', cmd: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'installer.test.ps1'] },
];
const only = process.argv.slice(2);
const picked = SUITES.filter((s) => (only.length ? only.includes(s.key) : true));
let totalFail = 0, ran = 0;
const lines = [];
for (const s of picked) {
  const file = s.args[s.args.length - 1];
  const t0 = Date.now();
  const r = spawnSync(s.cmd, s.args.map((a, i) => (i === s.args.length - 1 ? join(dir, a) : a)), { encoding: 'utf8', timeout: 600000, maxBuffer: 1 << 26 });
  if (s.optional && /Cannot find module|ENOENT|찾을 수 없/.test((r.stderr || '') + (r.stdout || '')) && r.status !== 0 && !/합계/.test(r.stdout || '')) { lines.push(`건너뜀  ${s.name}  (${file} 없음)`); continue; }
  ran++;
  const text = (r.stdout || '') + (r.stderr || '');
  const fails = text.split(/\r?\n/).filter((l) => /^FAIL/.test(l));
  const sum = (text.match(/합계:.*/) || ['(합계 줄 없음)'])[0];
  const bad = r.status !== 0;
  if (bad) totalFail++;
  lines.push(`${bad ? '실패  ' : '통과  '} ${s.name}  — ${sum}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  for (const f of fails) lines.push('        ' + f);
  if (bad && fails.length === 0) lines.push('        ' + text.split(/\r?\n/).filter(Boolean).slice(-6).join('\n        '));
}
console.log(lines.join('\n'));
console.log(`\n전체: ${ran}개 묶음 실행, 실패 ${totalFail}개`);
process.exit(totalFail ? 1 : 0);
