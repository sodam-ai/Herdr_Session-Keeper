// 꺼진 세션을 Herdr 에 새 탭으로 열어 이어서 시작한다 (Claude: claude --resume, Codex: codex resume).
// 이미 열려 있는 세션은 같은 대화를 두 곳에서 쓰는 사고를 막기 위해 절대 열지 않는다.
import { readdirSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { findCwd, projDir } from './claude.mjs';
import { herdrApp, openTab } from './herdr.mjs';

const CODEX_RECENT_MS = 120 * 1000;       // Codex 는 열려 있는지 완전히 알 수 없어서, 2분 안에 쓰인 세션은 아직 열려 있을 수 있다고 보고 막는다

const tabLabel = (row, cwd) => `복구 ${(row?.folder || basename(cwd)).replace(/^\d\dy_\d\dm_\d\dd_/, '').slice(0, 18)} ${row.sid.slice(0, 8)}`;

// 시험용: SESS_RESUME_TEMPLATE='Write-Output RESTORED-{sid}' 처럼 실제 AI 대신 무해한 명령으로 바꿔 검증할 수 있다.
export const commandFor = (row) => (process.env.SESS_RESUME_TEMPLATE || (row.ai === 'Codex' ? 'codex resume {sid}' : 'claude --resume {sid}')).replaceAll('{sid}', row.sid);

function alreadyRunning(row) {
  return { ok: false, code: 'ALREADY_RUNNING', message: `이미 실행 중입니다 (창: ${row.where || '확인 중'} ${row.addr || ''}). 같은 대화를 두 창에서 열면 기록이 꼬여서 열지 않습니다.` };
}

function launch(row, cwd, note) {
  if (!existsSync(herdrApp())) return { ok: false, code: 'NO_APP', message: `Herdr 앱을 찾지 못했습니다: ${herdrApp()}` };
  const name = tabLabel(row, cwd);
  const r = openTab({ argv: ['powershell.exe', '-NoExit', '-Command', commandFor(row)], folder: cwd, place: 'tab', name });
  if (!r.ok) return { ok: false, code: 'OPEN_FAILED', message: `Herdr 앱에 탭을 열지 못했습니다 (앱이 켜져 있어야 합니다): ${r.detail}` };
  return { ok: true, code: 'OPENED', message: `새 Herdr 탭 "${name}" 에서 이어서 시작합니다.${note ? ' ' + note : ''}`, terminal: r.terminal || '', tab: r.tab || '', cwd };
}

function resolveCwd(cwd) {
  if (cwd && existsSync(cwd)) return { cwd, note: '' };
  return { cwd: process.env.USERPROFILE || 'C:/', note: `원래 폴더(${cwd || '알 수 없음'})가 없어 홈 폴더에서 엽니다.` };
}

function openClaude(row) {
  let jsonl = null;
  try {
    for (const d of readdirSync(projDir(), { withFileTypes: true })) if (d.isDirectory() && existsSync(join(projDir(), d.name, row.sid + '.jsonl'))) { jsonl = join(projDir(), d.name, row.sid + '.jsonl'); break; }
  } catch { /* 폴더 없음 */ }
  if (!jsonl) return { ok: false, code: 'NO_TRANSCRIPT', message: '대화 기록 파일(.jsonl)이 없어서 이어서 열 수 없습니다.' };
  const { cwd, note } = resolveCwd(row.cwd || findCwd(jsonl, basename(dirname(jsonl)), ''));
  return launch(row, cwd, note);
}

function openCodex(row) {
  if (Date.now() - row.mtimeMs < CODEX_RECENT_MS) {
    return { ok: false, code: 'RECENTLY_ACTIVE', message: 'Codex 세션이 방금(2분 안에) 쓰여서 아직 열려 있을 수 있어 열지 않습니다. 잠시 뒤 다시 시도하세요.' };
  }
  const { cwd, note } = resolveCwd(row.cwd);
  return launch(row, cwd, note);
}

// row: collect 가 만든 행. 반환: {ok, code, message, ...}
export function restoreRow(row) {
  if (row.live) return alreadyRunning(row);
  return row.ai === 'Codex' ? openCodex(row) : openClaude(row);
}

// 세션이 "행 목록에는 없는" UUID 일 때(오래된 Claude 기록 등)를 위한 최소 행
export const stubRow = (sid) => ({ ai: 'Claude Code', sid, short: sid.slice(0, 8), live: false, folder: '', cwd: '', mtimeMs: 0, where: '', addr: '' });
