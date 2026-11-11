// build-kit.mjs - 설치 꾸러미(Claude Code 마켓플레이스 + 플러그인 + 직접 설치 스크립트)를 만든다.
// 원본(이 폴더의 키퍼·모드 파일, kit-src\)에서 매번 새로 만들므로 원본이 정본이다. 이 PC 전용 파일(기록·로그·역할표 등)은 넣지 않는다.
//   node build-kit.mjs               저장소 최상위에 만든다: .claude-plugin\ 와 plugins\ (GitHub 에서 /plugin marketplace add 로 바로 쓰려면 이 모양이어야 한다)
//   node build-kit.mjs <출력폴더>     그 폴더에 독립 꾸러미(README·LICENSE 포함)를 만든다(시험·압축 배포용)
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ROOT_MODE = !process.argv[2];
const OUT = ROOT_MODE ? ROOT : resolve(process.argv[2]);
const VERSION = '1.0.0';
const PLUGIN = join(OUT, 'plugins', 'herdr-session-keeper');
const PAYLOAD = join(PLUGIN, 'payload');

// 안전장치: 폴더를 통째로 지우는 것은 "독립 꾸러미" 모드에서만, 그것도 원본 폴더 자신이거나 그 상위면 거부한다.
// 저장소 최상위 모드에서는 .claude-plugin\ 과 plugins\ 두 폴더만 다시 만든다.
if (!ROOT_MODE && (ROOT.toLowerCase().startsWith(OUT.toLowerCase()) || OUT.length < 8)) { console.error('출력 폴더가 위험합니다:', OUT); process.exit(1); }
if (ROOT_MODE) { rmSync(join(OUT, 'plugins'), { recursive: true, force: true }); rmSync(join(OUT, '.claude-plugin'), { recursive: true, force: true }); }
else rmSync(OUT, { recursive: true, force: true });
mkdirSync(PAYLOAD, { recursive: true });

const need = (p) => { const f = join(ROOT, p); if (!existsSync(f)) { console.error('원본 파일이 없습니다:', f); process.exit(1); } return f; };
for (const n of ['session-keeper.ps1', 'session-keeper-watchdog.vbs', 'sessions.mjs', 'scan-monitors.mjs', 'herdr-launch.ps1', 'herdr-launch.vbs']) cpSync(need(n), join(PAYLOAD, n));
mkdirSync(join(PAYLOAD, 'lib'));
for (const f of readdirSync(join(ROOT, 'lib'))) if (/\.(mjs|ps1)$/.test(f)) cpSync(join(ROOT, 'lib', f), join(PAYLOAD, 'lib', f));
mkdirSync(join(PAYLOAD, 'mod'));
// main.js 의 const TOOL / const NODE 는 설치 때 install.ps1 이 이 PC 의 실제 경로로 채워 넣는다(원본에는 개인 경로가 없다)
for (const n of ['main.js', 'model.js', 'mod.json']) cpSync(need(join('herdr-mod', 'session-keeper', n)), join(PAYLOAD, 'mod', n));
cpSync(need('session-keeper-README.md'), join(PAYLOAD, 'README-program.md'));
writeFileSync(join(PAYLOAD, 'VERSION'), VERSION + '\n');

// 설치 도구(.ps1 은 한글이 있어 UTF-8 BOM + CRLF — Windows PowerShell 5.1 이 한글을 깨지 않게)
const bomCrlf = (t) => '\uFEFF' + t.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
for (const n of ['install.ps1', 'uninstall.ps1']) writeFileSync(join(PLUGIN, n), bomCrlf(readFileSync(need(join('kit-src', n)), 'utf8')), 'utf8');
writeFileSync(join(PLUGIN, 'install.cmd'), readFileSync(need('kit-src/install.cmd'), 'utf8').replace(/\r?\n/g, '\r\n'));
mkdirSync(join(PLUGIN, '.claude-plugin'), { recursive: true });
cpSync(need('kit-src/plugin.json'), join(PLUGIN, '.claude-plugin', 'plugin.json'));
mkdirSync(join(OUT, '.claude-plugin'), { recursive: true });
cpSync(need('kit-src/marketplace.json'), join(OUT, '.claude-plugin', 'marketplace.json'));
mkdirSync(join(PLUGIN, 'skills', 'herdr-session-keeper'), { recursive: true });
cpSync(need('kit-src/SKILL.md'), join(PLUGIN, 'skills', 'herdr-session-keeper', 'SKILL.md'));
cpSync(need('LICENSE'), join(PLUGIN, 'LICENSE'));                 // 플러그인 폴더 안에도 LICENSE(플러그인 복사본만 받아도 라이선스가 따라간다)
if (!ROOT_MODE) { cpSync(need('kit-src/README.md'), join(OUT, 'README.md')); cpSync(need('LICENSE'), join(OUT, 'LICENSE')); }

// 개인정보·이 PC 전용 경로가 꾸러미에 남지 않았는지 검사(발견 시 실패)
const rootFwd = ROOT.replace(/\\/g, '/').toLowerCase(), rootBack = ROOT.replace(/\//g, '\\').toLowerCase();
const bad = [];
const scan = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { scan(p); continue; }
    if (!/\.(ps1|mjs|js|vbs|json|md|cmd|txt)$/.test(e.name) && e.name !== 'LICENSE') continue;
    const t = readFileSync(p, 'utf8'), tl = t.toLowerCase();
    if (tl.includes(rootFwd) || tl.includes(rootBack)) bad.push(`${p} : 이 PC 의 프로젝트 폴더 경로`);
    for (const re of [/C:\\Users\\(?!tester\b|name\b|내이름\b|<)[A-Za-z0-9_.-]+/i, /@gmail\.com/i, /users\.noreply\.github\.com/i]) if (re.test(t)) bad.push(`${p} : ${re}`);
  }
};
scan(join(OUT, 'plugins')); scan(join(OUT, '.claude-plugin'));
if (bad.length) { console.error('개인/PC 전용 경로가 남아 있습니다:\n' + bad.join('\n')); process.exit(2); }
const mainJs = readFileSync(join(PAYLOAD, 'mod', 'main.js'), 'utf8');
if (!/const TOOL = "[^"]*";/.test(mainJs) || !/const NODE = "[^"]*";/.test(mainJs)) { console.error('main.js 에 const TOOL / const NODE 자리가 없습니다(설치가 값을 넣지 못함).'); process.exit(3); }
console.log('만들었습니다:', OUT, ROOT_MODE ? '(저장소 최상위: .claude-plugin, plugins)' : '(독립 꾸러미)', '/ 버전', VERSION);
