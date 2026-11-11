// 읽기 전용 집계: session-map 의 Claude 대화마다 "시점 T 에 켜져 있던 감시기(Monitor)·예약(ScheduleWakeup·Cron)" 수를 센다.
//  - Monitor: 시작 시각 ~ 시작+timeoutMs(persistent 면 끝없음) 사이이고 TaskStop(task_id) 전이면 "켜져 있음"
//  - ScheduleWakeup: 호출 시각 + delaySeconds 가 T 이후면 "대기 중 예약"
//  - Cron: CronCreate 중 CronDelete 가 없는 것
// 사용: node scan-monitors.mjs <T 의 UTC ISO>   (기본: 직전 재부팅 직전 2026-11-09T04:37:52Z = 한국시간 13:37:52)
// 어디서 실행해도 된다(이 파일 옆의 session-map.json 을 읽는다). 아무것도 쓰거나 바꾸지 않는다(읽기 전용).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 추가 인자(session-keeper.ps1 이 복구 결과 요약에 쓴다): --json(기계가 읽는 출력) / --sids a,b,c(그 세션 ID 만) / T 는 ISO 대신 밀리초 숫자도 가능
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const si = args.indexOf('--sids');
const sidSet = si >= 0 ? new Set(String(args[si + 1] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) : null;
const pos = args.find((a, i) => !a.startsWith('--') && !(si >= 0 && i === si + 1));
const T = /^\d{10,}$/.test(pos || '') ? Number(pos) : Date.parse(pos || '2026-11-09T04:37:52Z');
if (!Number.isFinite(T)) { console.error('시각(T)을 읽을 수 없습니다.'); process.exit(2); }
const map = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'session-map.json'), 'utf8').replace(/^\uFEFF/, ''));
const proj = join(process.env.APPDATA, 'claude-code', 'projects');
const dirs = readdirSync(proj);
const find = (sid) => { for (const d of dirs) { const f = join(proj, d, sid + '.jsonl'); if (existsSync(f)) return f; } return null; };
const rows = [];

for (const [addr, e] of Object.entries(map)) {
  if ((e.tool || 'claude') !== 'claude') continue;
  if (sidSet && !sidSet.has(String(e.sid).toLowerCase())) continue;
  const f = find(e.sid);
  if (!f) { rows.push({ addr, where: e.where, sid8: e.sid.slice(0, 8), note: '대화 파일 없음' }); continue; }
  const useById = new Map();
  const mon = [];
  const stops = new Map();
  const wake = [];
  const cron = new Map();
  const cronDel = new Set();
  let last = null, bgShell = 0;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const ts = o.timestamp ? Date.parse(o.timestamp) : null;
    if (ts) last = ts;
    const c = o?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type === 'tool_use') {
        useById.set(b.id, { name: b.name, input: b.input || {}, ts });
        if (b.name === 'TaskStop' && b.input?.task_id && ts) stops.set(String(b.input.task_id), ts);
        if (b.name === 'ScheduleWakeup' && ts) wake.push({ ts, delay: Number(b.input?.delaySeconds) || 0 });
        if (b.name === 'CronCreate' && ts) cron.set(b.id, { ts });
        if (b.name === 'CronDelete' && ts) cronDel.add(String(b.input?.id ?? ''));
        if ((b.name === 'Bash' || b.name === 'PowerShell') && b.input?.run_in_background && ts && Math.abs(ts - T) < 30 * 60e3) bgShell++;
      } else if (b?.type === 'tool_result') {
        const u = useById.get(b.tool_use_id);
        const r = o.toolUseResult;
        if (u?.name === 'Monitor' && r?.taskId && u.ts) {
          mon.push({ taskId: String(r.taskId), start: u.ts, end: r.persistent ? null : u.ts + (Number(r.timeoutMs) || 1800000), desc: String(u.input.description || '').slice(0, 60) });
        }
      }
    }
  }
  const activeAt = (t) => mon.filter((m) => m.start <= t && (m.end === null || t < m.end) && !(stops.has(m.taskId) && stops.get(m.taskId) <= t));
  const aT = activeAt(T);
  const aNow = activeAt(Date.now());
  const wT = wake.filter((w) => w.ts <= T && w.ts + w.delay * 1000 > T).length;
  rows.push({
    addr, where: e.where, sid: e.sid, sid8: e.sid.slice(0, 8), last: last ? new Date(last).toISOString().slice(0, 16) : '',
    monTotal: mon.length, monAtT: aT.length, monNow: aNow.length, wakeAtT: wT, cron: [...cron.keys()].filter((k) => !cronDel.has(k)).length,
    bgShellNearT: bgShell, descAtT: aT.map((m) => m.desc),
  });
}

const hit = rows.filter((r) => r.monAtT > 0 || r.wakeAtT > 0);
if (asJson) {
  console.log(JSON.stringify({ t: T, rows: rows.map((r) => ({ sid: r.sid, addr: r.addr, where: r.where, monAtT: r.monAtT ?? 0, wakeAtT: r.wakeAtT ?? 0, desc: r.descAtT ?? [] })) }));
  process.exit(0);
}
console.log(`T=${new Date(T).toISOString()} (한국시간 ${new Date(T + 9 * 3600e3).toISOString().slice(11, 19)})  세션 ${rows.length}개 중 T 시점에 감시/예약이 켜져 있던 세션: ${hit.length}개`);
for (const r of rows.sort((a, b) => (b.monAtT || 0) - (a.monAtT || 0))) {
  console.log(`${(r.addr || '').padEnd(5)} ${String(r.where || '').slice(0, 42).padEnd(42)} ${r.sid8}  Monitor 전체${String(r.monTotal ?? '-').padStart(3)} / T시점 켜짐 ${r.monAtT ?? '-'} / 지금 켜짐 ${r.monNow ?? '-'} / 예약대기 ${r.wakeAtT ?? '-'} / Cron미삭제 ${r.cron ?? '-'} / 백그라운드셸(T±30분) ${r.bgShellNearT ?? '-'} ${r.note || ''}`);
}
console.log('\n[T 시점에 켜져 있던 감시 설명]');
for (const r of hit) if (r.descAtT?.length) console.log(`${r.addr} ${r.where}: ${r.descAtT.join(' | ')}`);
