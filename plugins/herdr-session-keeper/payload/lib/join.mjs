// 세션 행과 Herdr 창을 연결하는 순수 함수들 (파일·프로세스를 직접 읽지 않아 시험하기 쉽다).

// 창의 셸 pid / 앞 프로그램 pid -> 창
export function windowsByPid(windows) {
  const map = new Map();
  for (const w of windows) { if (w.shellPid) map.set(w.shellPid, w); if (w.fgPid && !map.has(w.fgPid)) map.set(w.fgPid, w); }
  return map;
}

// pid 에서 부모를 거슬러 올라가며 창의 셸을 만나면 그 창을 돌려준다. 없으면 null.
export function ancestorWindow(pid, procs, byPid, maxDepth = 12) {
  let cur = pid;
  for (let i = 0; i < maxDepth && cur; i++) {
    if (byPid.has(cur)) return byPid.get(cur);
    const p = procs.get(cur);
    if (!p || !p.ppid || p.ppid === cur) return null;
    cur = p.ppid;
  }
  return null;
}

// Claude 실행 중 세션: 프로세스 계보로 정확한 창을 찾아 addr/where 를 덮어쓴다(못 찾으면 보조 값 유지). 새 배열을 돌려준다.
export function joinClaudeWindows(rows, procs, windows) {
  if (!procs.size || !windows.length) return rows;
  const byPid = windowsByPid(windows);
  return rows.map((r) => {
    if (!r.live || r.ai !== 'Claude Code' || !r.pid) return r;
    const w = ancestorWindow(r.pid, procs, byPid);
    return w ? { ...r, addr: w.addr, where: w.where } : r;
  });
}

// Codex(resume 로 켠 창): 프로세스 명령줄의 대화 ID -> 그 프로세스의 조상 셸 창. 제목 비교보다 정확하다.
// resume: Map<pid, 대화ID>. 반환: { rows(새 배열 또는 입력 그대로), addrs: 이미 연결된 창 주소 집합(제목 비교에서 빼기 위함) }
export function joinCodexResume(rows, resume, procs, windows) {
  const none = { rows, addrs: new Set() };
  if (!resume || !resume.size || !procs || !procs.size || !windows.length) return none;
  const byPid = windowsByPid(windows);
  const bySid = new Map();                                  // 대화ID -> 창
  for (const [pid, sid] of resume) { const w = ancestorWindow(pid, procs, byPid); if (w && !bySid.has(sid)) bySid.set(sid, w); }
  if (!bySid.size) return none;
  const addrs = new Set([...bySid.values()].map((w) => w.addr));
  return { rows: rows.map((r) => (r.ai === 'Codex' && bySid.has(String(r.sid).toLowerCase()) ? { ...r, live: true, addr: bySid.get(String(r.sid).toLowerCase()).addr, where: bySid.get(String(r.sid).toLowerCase()).where } : r)), addrs };
}

// Codex 창 제목은 "스레드 제목 | 폴더" 모양이다. 앞부분만 뽑아 비교용으로 정리한다.
export const windowTitleCore = (t) => String(t || '').split(' | ')[0].replace(/\s+/g, ' ').trim().toLowerCase();
const rowTitleCore = (r) => String(r.matchTitle ?? r.title ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// Codex: 열려 있는 Codex 창의 제목과 같은 스레드를 "실행 중"으로 표시한다.
// 같은 제목이 여러 개면 가장 최근에 갱신된 스레드 하나만(지금 열린 창이 쓰는 것) 실행 중으로 본다. 새 배열을 돌려준다.
export function joinCodexWindows(rows, windows) {
  const cw = windows.filter((w) => w.agent === 'codex' && windowTitleCore(w.title));
  if (!cw.length) return rows;
  const liveIdx = new Map();
  for (const w of cw) {
    const key = windowTitleCore(w.title);
    let best = -1;
    rows.forEach((r, i) => { if (r.ai === 'Codex' && rowTitleCore(r) === key && !liveIdx.has(i) && (best < 0 || r.mtimeMs > rows[best].mtimeMs)) best = i; });
    if (best >= 0) liveIdx.set(best, w);
  }
  return rows.map((r, i) => (liveIdx.has(i) ? { ...r, live: true, addr: liveIdx.get(i).addr, where: liveIdx.get(i).where } : r));
}
