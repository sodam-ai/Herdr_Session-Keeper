// README 시험: 한국어↔영어 구조 동일, 목차 링크 유효, md 글자 = html 글자, 디스크의 html 이 md 에서 만든 결과와 같음.
// (build-readme.mjs --check 는 파일을 쓰지 않는다.) 마지막 줄 "합계: PASS n / FAIL m" 형식은 run-all 이 읽는다.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync(process.execPath, [join(root, 'build-readme.mjs'), '--check'], { encoding: 'utf8', timeout: 60000 });
const out = (r.stdout || '') + (r.stderr || '');
let pass = 0, fail = 0;
for (const l of out.split('\n')) { if (l.startsWith('통과: ')) { pass++; console.log('PASS  ' + l.slice(4)); } else if (l.startsWith('실패: ')) { fail++; console.log('FAIL  ' + l.slice(4)); } else if (l.startsWith('  ')) console.log(l); }
if (r.status !== 0 && fail === 0) { fail++; console.log('FAIL  build-readme --check 종료 코드 ' + r.status); }
console.log(`합계: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
