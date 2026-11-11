// session-keeper 창의 "데이터 쪽" 로직: 화면 그리기와 상관없는 순수 함수만 둔다(Node 에서 그대로 시험할 수 있게 import 가 없다).
//   - buildItems : 도구가 준 세션 행 + Herdr 에이전트 목록 -> 화면에 그릴 항목(열린 창 / 꺼진 세션)
//   - groupDead  : 꺼진 세션을 프로젝트(폴더)별로 묶기 + 펼침 상태 계산
//   - matchItem  : 검색어 일치 여부

// 상태: 사람이 읽는 말, 정렬 순서(사람이 필요한 것이 먼저)
export const STATUS = {
  blocked: { word: "승인 대기", order: 0 },
  done: { word: "끝남", order: 1 },
  working: { word: "작업 중", order: 2 },
  idle: { word: "대기", order: 3 },
};

export const cleanName = (s) => String(s ?? "").replace(/\b\d\dy_\d\dm_\d\dd_/g, "");

export function ago(ms, now = Date.now()) {
  const s = (now - ms) / 1000;
  if (s < 90) return "방금";
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  const d = Math.round(s / 86400);
  return d <= 1 ? "어제" : `${d}일 전`;
}

export function matchItem(x, filterLower) {
  return !filterLower || `${x.title} ${x.where} ${x.ai} ${x.model} ${x.idShort} ${x.fullId} ${x.text}`.toLowerCase().includes(filterLower);
}

// ---- 복구 대기 / 꺼진 세션 정리 (세션키퍼 자동 복원이 남긴 기록을 화면에 보여 주기 위한 로직)
// ---- resume ID 복사 (2026-11-10)
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isResumeId = (s) => ID_RE.test(String(s ?? ""));
// 클립보드에 넣을 "이어서 시작" 명령. Claude = claude --resume <ID>, Codex = codex resume <ID>. ID 가 올바른 UUID 가 아니면 "".
// (UUID 로 검증된 값과 고정 글자만 쓰므로 그대로 셸에 붙여 넣어도 안전하다)
export function resumeCommand(x) {
  if (!isResumeId(x?.fullId)) return "";
  return /codex/i.test(String(x.ai ?? "")) ? `codex resume ${x.fullId}` : `claude --resume ${x.fullId}`;
}
// 모든 행에 항상 보여 줄 ID 칩. ok=true: label 을 누르면 전체 ID 복사 / ok=false: "ID 확인 불가"(눌렀을 때 why 를 상태줄에 보여 준다)
export function idChip(x) {
  if (isResumeId(x?.fullId)) return { ok: true, label: `ID ${String(x.fullId).slice(0, 8)}`, why: "" };
  const codex = /codex/i.test(String(x?.ai ?? ""));
  return { ok: false, label: "ID 확인 불가", why: codex ? "이 Codex 창의 대화 ID 를 확정하지 못했습니다(같은 폴더에 새로 켠 Codex 창이 둘 이상이면 어느 대화인지 가릴 수 없습니다). codex resume <ID> 로 켠 창은 ID 가 보입니다." : "이 창에 연결된 대화 ID 를 찾지 못했습니다." };
}

export const MAX_ATTEMPTS = 3;                // session-keeper.ps1 의 자동 시도 한도(이후엔 자동 복구가 포기한다)

// 제목이 의미 없는 세션(명령줄로 시작한 "! powershell…", 시스템 태그, 제목 없음)은 어느 폴더의 작업인지로 대신 부른다.
const WEIRD_TITLE = /^(!\s|<[a-z][\w-]*>|\(제목 없음\))/i;
export function niceTitle(title, cwd, home = "") {
  const t = String(title ?? "").replace(/\s+/g, " ").trim();
  if (t.length >= 2 && !WEIRD_TITLE.test(t)) return t;
  return `${groupLabel(cwd, home)} 폴더의 작업 (이름 없음)`;
}

// 복구 대기 항목의 상태 말: 대화 기록 없음 > 자동 복구 실패(한도 초과) > 복구 대기
export function pendingState(x) {
  if (x.missing) return { word: "복구 불가", why: "대화 기록(파일)을 찾지 못했습니다. 목록에서 제외하는 것만 가능합니다.", tone: "bad" };
  if ((x.keeper?.attempts ?? 0) >= MAX_ATTEMPTS) return { word: "자동 복구 실패", why: `자동으로 ${MAX_ATTEMPTS}번 시도했지만 되살리지 못했습니다. [복구]는 새 탭으로 이어서 시작합니다.`, tone: "warn" };
  // 자동 복구는 "닫히기 직전에 열려 있던 창"만 한다. 그 전에 닫혀 남아 있던 항목은 자동으로 되살리지 않고, [복구]를 눌러야 되살린다.
  if (x.keeper?.auto === false) return { word: "직접 복구", why: "닫히기 직전에 열려 있던 창이 아니어서 자동으로는 복구하지 않습니다. [복구]를 누르면 되살립니다.", tone: "wait" };
  return { word: "복구 대기", why: "", tone: "wait" };
}
// 이 항목을 키퍼에게 맡길 수 있는지(빈 셸에 입력 / 같은 공간에 새 탭). 아니면 [복구]는 새 탭 열기(sessions.mjs open)를 쓴다.
export const canAutoRecover = (x) => !x.missing && !!x.keeper?.addr && (x.keeper?.attempts ?? 0) < MAX_ATTEMPTS;

// 자연스러운 이름 순서: 숫자 덩어리는 크기로 비교한다(Tab-2 가 Tab-10 보다 먼저).
// localeCompare 의 numeric 옵션은 Herdr 모드 실행 환경에서 무시되는 것이 실제 화면에서 확인되어(1, 10, 2 순으로 나옴) 직접 구현한다.
export function natCmp(a, b) {
  const pa = String(a ?? "").toLowerCase().match(/\d+|\D+/g) ?? [];
  const pb = String(b ?? "").toLowerCase().match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === y) continue;
    if (/^\d/.test(x) && /^\d/.test(y)) { const d = Number(x) - Number(y); if (d !== 0) return d; continue; }
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

// 복구 대기 항목을 공간(Herdr 의 작업 묶음) 이름으로 묶는다. 반환: [{key,label,items,count}] (공간 이름순, 안은 탭 이름순)
export function groupPending(items) {
  const byKey = new Map();
  for (const x of items) {
    const key = x.keeper?.space || "";
    byKey.set(key, [...(byKey.get(key) ?? []), x]);
  }
  return [...byKey.entries()]
    .map(([key, list]) => ({
      key, label: key === "~" ? "홈 (~)" : cleanName(key) || "(공간 정보 없음)", count: list.length,
      items: [...list].sort((a, b) => natCmp(cleanName(a.keeper?.tab), cleanName(b.keeper?.tab)) || a.sortAt - b.sortAt),
    }))
    .sort((a, b) => natCmp(a.label, b.label));
}

// 같은 AI·같은 폴더·같은 제목으로 거의 똑같이 쌓인 세션은 가장 최근 것 하나만 보여 주고 나머지는 개수(dups)로 접는다.
export function dedupeDead(items) {
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 36);
  const best = new Map();
  for (const x of items) {
    const key = `${x.ai}|${normPath(x.cwd)}|${norm(x.title)}`;
    const cur = best.get(key);
    if (!cur) best.set(key, { ...x, dups: 0 });
    else if (x.sortAt > cur.sortAt) best.set(key, { ...x, dups: cur.dups + 1 });
    else cur.dups++;
  }
  return [...best.values()];
}

// AI 종류 거르기: which = "all" | "claude" | "codex"
export function filterAi(items, which) {
  if (which === "claude") return items.filter((x) => /claude/i.test(x.ai));
  if (which === "codex") return items.filter((x) => /codex/i.test(x.ai));
  return items;
}

// 키퍼의 집계 줄("대상 12개 = 성공 10 / 실패 1 / 건너뜀 1 (그중 이미 실행 중 0) / 시간 안에 못 끝낸 것 0")을 쉬운 말로.
// 모양이 다르면(키퍼 문구가 바뀌면) 원문을 그대로 돌려준다.
export function plainTally(tally) {
  const m = /대상\s*(\d+)개\s*=\s*성공\s*(\d+)\s*\/\s*실패\s*(\d+)\s*\/\s*건너뜀\s*(\d+)(?:\s*\(그중 이미 실행 중\s*(\d+)\))?(?:\s*\/\s*시간 안에 못 끝낸 것\s*(\d+))?/.exec(String(tally ?? ""));
  if (!m) return String(tally ?? "");
  const [total, ok, fail, skip, running, waiting] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
  const parts = [`${total}개 중 ${ok}개 복구`];
  if (fail) parts.push(`${fail}개 실패`);
  if (skip) parts.push(running ? `${skip}개 건너뜀(${running}개는 이미 실행 중)` : `${skip}개 건너뜀`);
  if (waiting) parts.push(`${waiting}개는 시간이 모자라 못 끝냄`);
  return parts.join(" · ");
}

// 맨 위 "마지막 복구 결과" 한 줄. last = lastRestore() 결과 또는 null. level: ok | none | warn | bad | unknown
// attention: 확인이 필요한 결과(주의·확인 필요)면 true — 다른 탭에서도 이때만 한 줄을 보여 준다.
export function lastBanner(last) {
  if (!last) return { level: "none", attention: false, text: "아직 자동 복구 기록이 없습니다. 컴퓨터를 켜거나 Herdr를 다시 켜면 결과가 여기에 표시됩니다." };
  const when = String(last.at || "").slice(5);
  const verdict = String(last.verdict ?? "").replace(/(\d+) 개/g, "$1개").replace(" - ", " — ");
  const level = last.level || "unknown";
  return { level, attention: level === "warn" || level === "bad", text: `마지막 복구 ${when ? when + " · " : ""}${verdict}`, detail: plainTally(last.tally) };
}

// Herdr 앱 업데이트 한 줄. s = sessions.mjs update-state 결과 {kind: ready|restart|none, auto, installed, staged} 또는 null.
// 보여 줄 것이 없으면(최신이고 자동 업데이트도 켜져 있음) null. apply: [업데이트] 버튼을 보일지, auto: 자동 업데이트 켜짐 여부.
export function appUpdateLine(s) {
  if (!s || typeof s !== "object") return null;
  const auto = s.auto !== false;
  const inst = String(s.installed || "").trim(), stg = String(s.staged || "").trim();
  if (s.kind === "ready") return { apply: true, auto, text: `Herdr 새 버전${stg ? " " + stg : ""} 업데이트 대기${inst ? ` (지금 ${inst})` : ""} — 열려 있어도 적용됩니다. 창만 잠깐 껐다 켜고 터미널은 그대로입니다.` };
  if (s.kind === "restart") return { apply: true, auto, text: `Herdr 앱 파일은 이미 새 버전${inst ? " " + inst : ""}입니다. 창을 껐다 켜면 반영됩니다(터미널은 그대로).` };
  if (!auto) return { apply: false, auto, text: "Herdr 앱 자동 업데이트가 꺼져 있습니다." };
  return null;
}

// ---- 열려 있는 창: 상태 요약·거르기·공간별 묶기
export const STATUS_KEYS = ["blocked", "working", "done", "idle"];
export function liveSummary(live) {
  const c = { blocked: 0, working: 0, done: 0, idle: 0 };
  for (const x of live) c[STATUS[x.status] ? x.status : "idle"]++;
  return c;
}
export const filterLive = (live, status) => (status && status !== "all" ? live.filter((x) => (STATUS[x.status] ? x.status : "idle") === status) : live);

// 공간(Herdr 의 작업 묶음)별로 묶는다. 사람이 필요한(승인 대기가 많은) 공간이 먼저, 안은 "승인 대기 → 끝남 → 작업 중 → 대기" 순서 뒤에 탭 이름 순서.
export function groupLive(live) {
  const rank = (x) => STATUS[x.status]?.order ?? 9;
  const byKey = new Map();
  for (const x of live) byKey.set(x.space ?? "", [...(byKey.get(x.space ?? "") ?? []), x]);
  return [...byKey.entries()]
    .map(([key, list]) => ({
      key, label: key === "~" ? "홈 (~)" : cleanName(key) || "(공간 정보 없음)", count: list.length,
      blocked: list.filter((x) => x.status === "blocked").length,
      items: [...list].sort((a, b) => rank(a) - rank(b) || natCmp(a.tab, b.tab) || natCmp(a.title, b.title)),
    }))
    .sort((a, b) => b.blocked - a.blocked || natCmp(a.label, b.label));
}

// ---- "전부 복구" 미리보기(키퍼 -Plan 결과)를 사람이 읽는 말로
export function planWord(p) {
  if (!p) return "";
  if (p.action === "TYPE") return "빈 창에 이어서 입력";
  if (p.action === "CREATE") return "새 탭으로 열기";
  return `건너뜀 — ${p.reason}`;
}
export function planSummary(items) {
  const n = { TYPE: 0, CREATE: 0, SKIP: 0 };
  for (const p of items) n[p.action in n ? p.action : "SKIP"]++;
  return [n.TYPE && `빈 창에 입력 ${n.TYPE}`, n.CREATE && `새 탭 ${n.CREATE}`, n.SKIP && `건너뜀 ${n.SKIP}`].filter(Boolean).join(" · ") || "복구할 작업 없음";
}

// 열려 있는 창은 Herdr 의 에이전트 목록(agentList)이 기준이고, 도구가 준 세션 정보(ID·모델·제목)를 창 주소로 붙인다.
// 반환: live(열린 창) / pending(복구 대기: 키퍼가 기억하는 꺼진 작업) / dead(그 밖의 꺼진 세션)
export function buildItems(rows, agentList, { home = "" } = {}) {
  const byAddr = new Map(rows.filter((r) => r.live && r.addr).map((r) => [r.addr, r]));
  const live = agentList.map((a) => {
    const r = byAddr.get(a.address);
    const isClaude = a.app === "claude-code";
    return {
      key: `live-${a.address}`, live: true, addr: a.address, status: a.status,
      ai: r?.ai ?? (isClaude ? "Claude Code" : (a.program?.name ?? a.app ?? "AI")),
      model: r?.model ?? "",
      title: (r?.title && r.title !== "(제목 없음)" ? r.title : a.title) || "(제목 없음)",
      where: cleanName(`${a.space_name} / ${a.tab_name}`), space: cleanName(a.space_name), tab: cleanName(a.tab_name),
      idShort: r ? r.short : a.address, fullId: r ? r.sid : "", idKind: r ? "ID" : "창",
      cwd: r?.cwd ?? "", sortAt: r ? r.mtimeMs : 0,
      text: `${a.title} ${a.space_name} ${a.tab_name} ${a.program?.name ?? ""} ${r?.sid ?? ""} ${r?.lastPrompt ?? ""}`,
    };
  });
  const have = new Set(live.map((x) => x.fullId).filter(Boolean));
  const outside = rows   // Herdr 밖에서 실행 중인 세션
    .filter((r) => r.live && !have.has(r.sid) && !(r.addr && live.some((x) => x.addr === r.addr)))
    .map((r) => ({
      key: `out-${r.sid}`, live: true, addr: "", status: "idle", ai: r.ai ?? "Claude Code", model: r.model ?? "", title: r.title,
      where: "Herdr 밖에서 실행 중", space: "Herdr 밖에서 실행 중", tab: "", idShort: r.short, fullId: r.sid, idKind: "ID", cwd: r.cwd ?? "", sortAt: r.mtimeMs,
      text: `${r.title} ${r.folder} ${r.sid} ${r.lastPrompt}`,
    }));
  const deadAll = rows
    .filter((r) => !r.live)
    .map((r) => ({
      key: `dead-${r.sid}`, live: false, addr: "", status: "", ai: r.ai ?? "Claude Code", model: r.model ?? "", title: niceTitle(r.title, r.cwd, home),
      where: r.keeper?.work ? cleanName(r.keeper.work) : (r.where ? cleanName(r.where) : cleanName(r.folder)), idShort: r.short, fullId: r.sid, idKind: "ID", cwd: r.cwd ?? "", sortAt: r.mtimeMs,
      keeper: r.keeper ?? null, missing: !!r.missing, dups: 0,
      text: `${r.title} ${r.folder} ${r.where} ${r.sid} ${r.lastPrompt} ${r.keeper?.work ?? ""}`,
    }));
  const pending = deadAll.filter((x) => x.keeper?.pending);
  const dead = deadAll.filter((x) => !x.keeper?.pending);
  const bucket = (a) => STATUS[a.status]?.order ?? 9;
  return { live: [...live, ...outside].sort((a, b) => bucket(a) - bucket(b) || a.where.localeCompare(b.where)), pending, dead };
}

const normPath = (p) => String(p ?? "").replace(/[\\/]+$/, "").toLowerCase();

export function groupLabel(cwd, home) {
  if (!cwd) return "(폴더 정보 없음)";
  if (home && normPath(cwd) === normPath(home)) return "홈 폴더";
  const base = String(cwd).split(/[\\/]/).filter(Boolean).pop() || String(cwd);
  return cleanName(base);
}

// 꺼진 세션을 폴더(프로젝트)별로 묶는다. 반환: [{key, label, items, count, latest, open}] (최근에 쓴 그룹이 먼저)
// open: 검색 중이면 전부 펼침. 아니면 사용자가 누른 상태(openOverrides)가 우선, 없으면 "최근 2개 그룹 또는 3개 이하인 그룹"을 펼침.
export function groupDead(items, { filter = "", openOverrides = {}, home = "" } = {}) {
  const f = String(filter).trim().toLowerCase();
  const byKey = new Map();
  const shown = items.filter((i) => matchItem(i, f));
  for (const x of (f ? shown.map((i) => ({ ...i, dups: 0 })) : dedupeDead(shown))) {   // 검색 중에는 비슷한 세션도 접지 않고 전부 보여 준다
    const key = normPath(x.cwd);
    byKey.set(key, [...(byKey.get(key) ?? []), x]);
  }
  const groups = [...byKey.entries()]
    .map(([key, list]) => {
      const sorted = [...list].sort((a, b) => b.sortAt - a.sortAt);
      return { key, label: groupLabel(sorted[0].cwd, home), items: sorted, count: sorted.reduce((n, x) => n + 1 + (x.dups ?? 0), 0), latest: sorted[0].sortAt };
    })
    .sort((a, b) => b.latest - a.latest);
  return groups.map((g, i) => ({ ...g, open: f ? true : (g.key in openOverrides ? !!openOverrides[g.key] : (i < 2 || g.items.length <= 3)) }));   // 비슷한 세션이 접혀 줄 수가 적으면(보이는 줄 기준) 펼쳐 둔다
}
