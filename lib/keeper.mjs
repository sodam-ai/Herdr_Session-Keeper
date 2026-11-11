// 세션키퍼 자동 복원(session-keeper.ps1)이 남긴 기록을 창 쪽에서 읽는 부품. 파일을 읽기만 하고, 프로세스 실행·파일 쓰기는 하지 않는다.
//   - session-map.json   : 창 주소 -> 세션 ID / 공간 / 탭 / 시도 횟수 / 닫힘(orphan) 여부   (키퍼가 1분마다 적는다)
//   - LAST-RESTORE.txt   : 가장 최근 복구 결과 요약 (판정 줄 포함)
// "복구 대기"의 기준은 session-keeper.ps1 Invoke-RecoverCore 와 같다: (이번 부팅 기록이 아님) 또는 (닫혀서 보존된 orphan).
import { readFileSync, existsSync } from 'node:fs';
import { uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { readJson } from './common.mjs';

export const MAX_ATTEMPTS = 3;                 // session-keeper.ps1 -MaxAttempts 와 같은 값
const BOOT_TOLERANCE_MS = 180000;              // 키퍼가 적은 부팅 시각과 지금 계산한 부팅 시각의 허용 오차

export const bootMs = (now = Date.now(), up = uptime()) => now - up * 1000;

export function isPendingEntry(e, boot = bootMs()) {
  if (!e || !e.sid) return false;
  if (e.orphan) return true;
  const t = Date.parse(e.boot);
  return Number.isFinite(t) ? Math.abs(t - boot) > BOOT_TOLERANCE_MS : true;   // 부팅 기록이 없거나 깨졌으면 키퍼처럼 대기로 본다
}

// 자동 복구는 "닫히기 직전에 열려 있던 창"만 한다(session-keeper.ps1 -RecentMin, 기준 시각 = 대기 기록 중 가장 늦게 확인된 시각 - 10분).
// 기준 시각은 키퍼가 사건(앱이 새로 켜짐)마다 한 번 정해 session-keeper.cutoff 에 적는다. 그 파일이 없으면 지금 대기 기록으로 같은 식으로 계산한다.
export const RECENT_MIN = 10;
export function readCutoffMs(mapFile) {
  try { const t = Date.parse(readFileSync(join(dirname(mapFile), 'session-keeper.cutoff'), 'utf8').trim()); return Number.isFinite(t) ? t : null; } catch { return null; }
}
// 이 대기 항목이 자동 복구 대상인가. 확인 시각을 모르면(0) 빠뜨리지 않도록 대상으로 본다.
export const isAutoTarget = (seenMs, cutoffMs) => cutoffMs == null || !seenMs || seenMs >= cutoffMs;

// Herdr 앱 업데이트 상태(키퍼 lib/appupdate.ps1 이 5분마다 session-keeper.appupdate.json 에 적는다) + 자동 업데이트 켜짐 여부(.off 파일이 있으면 꺼짐).
// kind: ready(새 버전이 받아져 있음) | restart(파일은 새것, 열린 창은 옛것) | none. 키퍼가 20분 넘게 갱신하지 않았으면 낡은 것으로 보고 none.
const APPUPD_FRESH_MS = 20 * 60000;
export function readAppUpdate(dir) {
  const auto = !existsSync(join(dir, 'session-keeper.appupdate.off'));
  const base = { kind: 'none', auto, installed: '', staged: '' };
  let st = null;
  try { st = JSON.parse(readFileSync(join(dir, 'session-keeper.appupdate.json'), 'utf8').replace(/^﻿/, '')); } catch { return base; }
  if (!st || typeof st !== 'object') return base;
  const t = Date.parse(st.checkedAt);
  const fresh = Number.isFinite(t) && Date.now() - t <= APPUPD_FRESH_MS;
  const kind = fresh && (st.kind === 'ready' || st.kind === 'restart') ? st.kind : 'none';
  return { kind, auto, installed: String(st.installed || '').slice(0, 20), staged: String(st.staged || '').slice(0, 20) };
}

// 지도 파일 -> Map(sid -> 항목). 읽지 못하면 빈 Map.
export function keeperIndex(mapFile, boot = bootMs()) {
  const idx = new Map();
  const m = readJson(mapFile);
  if (!m || typeof m !== 'object') return idx;
  for (const e of Object.values(m)) {
    if (!e || typeof e !== 'object' || !e.sid) continue;
    const seen = Date.parse(e.seen);
    idx.set(String(e.sid), {
      sid: String(e.sid), addr: String(e.addr || ''), where: String(e.where || ''), space: String(e.space || ''), tab: String(e.tab || ''),
      cwd: String(e.cwd || ''), tool: e.tool === 'codex' ? 'codex' : 'claude', attempts: Number(e.attempts) || 0,
      orphan: !!e.orphan, pending: isPendingEntry(e, boot), seenMs: Number.isFinite(seen) ? seen : 0, auto: true,
    });
  }
  const pend = [...idx.values()].filter((k) => k.pending);
  let cutoff = readCutoffMs(mapFile);
  if (cutoff == null) { const mx = Math.max(0, ...pend.map((k) => k.seenMs)); cutoff = mx ? mx - RECENT_MIN * 60000 : null; }
  for (const k of pend) k.auto = isAutoTarget(k.seenMs, cutoff);
  return idx;
}

// 세션 행에 키퍼 정보를 붙인다(새 배열). 실행 중이 아닌데 복구 대기 기록이 있으면 pending:true.
export function decorateKeeper(rows, index) {
  if (!index || index.size === 0) return rows;
  return rows.map((r) => {
    const k = index.get(r.sid);
    if (!k) return r;
    return { ...r, keeper: { pending: !r.live && k.pending, addr: k.addr, work: k.where, space: k.space, tab: k.tab, attempts: k.attempts, orphan: k.orphan, seenMs: k.seenMs, auto: k.auto } };
  });
}

// 복구 대기 기록은 있는데 대화 기록(파일/DB)을 찾지 못한 세션 -> 화면에 "복구할 수 없음"으로 보여 주기 위한 빈 행.
// (Claude 가 오래된 대화 파일을 지웠을 때 조용히 사라지지 않게 한다)
export function missingStubs(rows, index) {
  if (!index) return [];
  const have = new Set(rows.map((r) => r.sid));
  const out = [];
  for (const k of index.values()) {
    if (!k.pending || have.has(k.sid)) continue;
    out.push({
      ai: k.tool === 'codex' ? 'Codex' : 'Claude Code', model: '', sid: k.sid, short: k.sid.slice(0, 8),
      title: '(대화 기록을 찾지 못했습니다)', lastPrompt: '', cwd: k.cwd, folder: k.cwd ? k.cwd.split(/[\\/]/).filter(Boolean).pop() || k.cwd : '',
      mtime: '', mtimeMs: k.seenMs, live: false, pid: null, addr: '', where: k.where, missing: true,
      keeper: { pending: true, addr: k.addr, work: k.where, space: k.space, tab: k.tab, attempts: k.attempts, orphan: k.orphan, seenMs: k.seenMs, auto: k.auto },
    });
  }
  return out;
}

// LAST-RESTORE.txt -> { at, verdict, level, tally } 또는 null
//   level: ok(정상) | none(복구할 것 없음) | warn(주의) | bad(확인 필요) | unknown
export function parseLastRestore(text) {
  const t = String(text || '').replace(/^\uFEFF/, '');
  const verdict = /^판정:\s*(.+)$/m.exec(t)?.[1]?.trim();
  if (!verdict) return null;
  const at = /^작성:\s*(\d{4}-\d\d-\d\d \d\d:\d\d)/m.exec(t)?.[1] || '';
  const tally = /^집계:\s*(.+)$/m.exec(t)?.[1]?.trim() || '';
  const level = /^정상/.test(verdict) ? 'ok' : /^복구할 것 없음/.test(verdict) ? 'none' : /^주의/.test(verdict) ? 'warn' : /^확인 필요/.test(verdict) ? 'bad' : 'unknown';
  return { at, verdict, level, tally };
}

export function lastRestore(dir) {
  try { return parseLastRestore(readFileSync(join(dir, 'LAST-RESTORE.txt'), 'utf8')); } catch { return null; }
}

// session-keeper.ps1 -Mode Recover -Plan 의 출력을 읽는다. 항목 줄 모양(Write-Log):
//   "2026-11-04 02:34:06 TYPE t1    작업공간 / 탭1                  cb7542a0  -> 빈 셸, 입력 가능"   (TYPE 빈 셸에 입력 / CREATE 새 탭 / SKIP 건너뜀)
// 마지막에 "복구 라운드: 대기 N / 실행 예정 N / 나중에 재시도 N / 건너뜀 N  (모드: 미리보기)" 줄이 나오면 끝난 것이다. 대기 항목이 없으면 이 줄 없이 끝난다(done=false).
export function parsePlan(text) {
  const items = [];
  let done = false;
  for (const line of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d (TYPE|CREATE|SKIP)\s+(t[0-9a-z]+)\s+(.*?)\s+([0-9a-f]{8})\s+->\s+(.*?)\s*$/.exec(line);
    if (m) items.push({ action: m[1], addr: m[2], where: m[3].trim(), sid8: m[4], reason: m[5] });
    else if (/복구 라운드:.*미리보기/.test(line)) done = true;
  }
  return { items, done };
}

// 키퍼 스크립트를 부르는 명령(실행은 호출한 쪽). 입력은 엄격히 검사해서 명령줄에 이상한 글자가 들어가지 못하게 한다.
export const SID_RE = /^[0-9a-f-]{6,36}$/i;
export const ADDR_RE = /^t[0-9a-z]{1,10}$/i;                // Herdr 창 주소(t3z, t107 …): 길이 제한으로 터무니없는 입력을 거른다
// 오래 걸리는 일(복구·미리보기)은 "백그라운드"로 띄운다. Node 는 (1) 분리하지 않고 띄운 자식을 부모가 끝날 때 함께 종료시키고
// (2) 분리(detached)해서 띄운 PowerShell 은 콘솔이 없어 일을 하지 않고 곧바로 끝낸다(실측: 0.6초 만에 종료 코드 0, 결과 없음).
// 그래서 짧게 사는 PowerShell 이 Start-Process 로 키퍼를 띄우고 바로 끝난다(손자 프로세스는 부모와 함께 죽지 않는다).
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
function background(script, extra, outFile) {
  if (/"/.test(script)) return { error: '키퍼 경로에 따옴표가 있어 실행할 수 없습니다.' };
  const inner = `-NoProfile -ExecutionPolicy Bypass -File "${script}" ${extra}`;
  const redirect = outFile ? ` -RedirectStandardOutput ${q(outFile)}` : '';
  return { file: 'powershell.exe', background: true, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Start-Process -FilePath powershell.exe -ArgumentList ${q(inner)} -WindowStyle Hidden${redirect}`] };
}

export function keeperCommand(kind, arg, dir, outFile = '') {
  const script = join(dir, 'session-keeper.ps1');
  const base = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
  if (kind === 'forget') {                                                         // 몇 초면 끝나서 기다린다
    if (!SID_RE.test(String(arg || ''))) return { error: '세션 ID 앞 6자 이상이 필요합니다.' };
    return { file: 'powershell.exe', args: [...base, '-Mode', 'Forget', '-Sid', String(arg).toLowerCase()] };
  }
  if (kind === 'forget-old') {                                                     // "닫히기 직전"이 아닌 옛 대기 항목 일괄 제외(키퍼가 먼저 백업을 만든다). 몇 초면 끝나서 기다린다
    return { file: 'powershell.exe', args: [...base, '-Mode', 'Forget', '-Stale'] };
  }
  if (kind === 'update') return background(script, '-Mode Update');               // Herdr 앱 업데이트 적용 + 창만 껐다 켬(터미널은 코어가 유지). 오래 걸려 백그라운드로 띄운다
  if (kind === 'update-auto') {                                                    // 앱 자동 업데이트 켜기/끄기(몇 초면 끝나서 기다린다)
    if (arg !== 'On' && arg !== 'Off') return { error: '켜기(On) 또는 끄기(Off)만 가능합니다.' };
    return { file: 'powershell.exe', args: [...base, '-Mode', 'Update', '-Auto', arg] };
  }
  if (kind === 'plan') {                                                           // 입력·생성 없이 "무엇을 할지"만. 출력은 결과 파일로 받는다
    if (!outFile) return { error: '결과 파일 경로가 필요합니다.' };
    return background(script, '-Mode Recover -Plan', outFile);
  }
  if (kind === 'recover') {
    if (arg === 'all') return background(script, '-Mode Recover');
    if (!ADDR_RE.test(String(arg || ''))) return { error: '창 주소(예: t3z) 또는 all 이 필요합니다.' };
    return background(script, `-Mode Recover -Only ${arg}`);
  }
  return { error: `알 수 없는 명령: ${kind}` };
}
