// session-keeper (세션키퍼) - Herdr 안에서 "복구 대기 작업", "지금 열려 있는 AI 창", "꺼진 Claude·Codex 세션"을 보고, 골라서 복구하는 창.
// (같은 이름의 session-keeper.ps1 = 재부팅 후 창 자동 복원 은 이 창과 한 기능의 다른 부분이다)
//
// 여는 법: Ctrl+Shift+R (install-herdr-mod.ps1 이 연결), 또는 명령 팔레트(Ctrl+Shift+P)에서 "mod.open session-keeper".
// 화면 설계(2026-11-04 2차): 실제 Herdr 창이 세로 685px 라 예전 화면은 목록이 3줄만 보였다 -> 위쪽을 2줄로 줄이고 행을 한 줄(38px)로 압축했다.
//   위쪽  : [제목 · 탭 3개 · 검색 · 새로고침]  /  [탭별 도구줄: 복구 대기=전부 복구·미리보기, 열린 창=상태 칩, 꺼진 세션=AI 거르기]
//   탭    : 복구 대기(닫히거나 꺼져 자동 복구를 기다리는 작업) · 열려 있는 창(공간별, 승인 대기 먼저) · 꺼진 세션(폴더별)
//   아래  : 상태 한 줄 / 단축키 안내
//   키보드: Esc 닫기, Ctrl+1/2/3 탭 바꾸기, 검색창에서 Enter = 첫 결과 실행
// 실제 목록·복구 일은 sessions.mjs 가 한다(설치 프로그램이 아래 TOOL 에 그 파일의 실제 경로를 채워 넣는다)
//   - 목록: node sessions.mjs json            (읽기 전용: 세션 ID·제목·폴더·모델 + 키퍼의 복구 대기 정보)
//   - 결과: node sessions.mjs last            (읽기 전용: 마지막 자동 복구 결과)
//   - 복구(꺼진 세션): node sessions.mjs open <ID> --json     (새 탭에 claude --resume / codex resume. 이미 실행 중이면 거부)
//   - 복구(복구 대기): node sessions.mjs recover <창 주소|all> --json   (키퍼가 빈 셸에 입력하거나 같은 공간에 새 탭을 만듦. 백그라운드로 시작)
//   - 미리보기: node sessions.mjs plan start --json / plan read   (키퍼 -Plan: 입력·생성 없이 항목별 계획만)
//   - 목록에서 빼기: node sessions.mjs forget <ID> --json    (영영 끝낸 작업을 복구 대기에서 뺌. 대화 기록은 지우지 않음)
//   - 이동: run("agent.focus") 로 실행 중인 창으로 화면만 옮김
// 데이터를 다루는 순수 로직(항목 만들기·묶기·검색·상태 말·쉬운 말 변환)은 ./model.js 에 있고 tests/ 에서 시험한다. 이 파일은 화면 그리기와 버튼만 맡는다.
// 이 모드가 직접 파일을 쓰거나 다른 창에 입력을 보내지는 않는다(그 일은 위 도구가 한다).
// 글자 색: 읽어야 하는 글자는 t.muted(대비 5:1 이상)를 쓴다. t.dim(2.8:1)은 읽을 필요 없는 장식에만.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, agents, keys, home, theme, run, notify, props, closeOverlay } from "herdr";
import {
  STATUS, STATUS_KEYS, ago, buildItems, groupDead, groupPending, groupLive, liveSummary, filterLive, matchItem, filterAi, lastBanner, appUpdateLine,
  pendingState, canAutoRecover, planWord, planSummary, MAX_ATTEMPTS, resumeCommand, idChip,
} from "./model.js";

const NODE = "node";
const TOOL = "sessions.mjs";   // 설치 때 install-herdr-mod.ps1 / install.ps1 이 절대 경로로 바꾼다
const REFRESH_MS = 20000;
const FAST_MS = 5000;                  // 전부 복구가 진행되는 동안의 새로고침 간격
const RECOVER_WATCH_MS = 15 * 60000;   // 이 시간이 지나면 진행 표시를 접는다
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROW_H = 38;

const aiColor = (name) => (/claude/i.test(name) ? "#e0865a" : /codex/i.test(name) ? "#4fb286" : "#9aa0a6");
const STATUS_LABEL = { all: "전체", blocked: "승인 대기", working: "작업 중", done: "끝남", idle: "대기" };

export default class SessionKeeper extends View {
  init(_props, cx) {
    this.rows = [];
    this.last = null;            // 마지막 자동 복구 결과 {at, verdict, level, tally}
    this.appUpd = null;          // Herdr 앱 업데이트 상태 {kind, auto, installed, staged} (sessions.mjs update-state)
    this.filter = "";
    this.view = "live";          // "pending" 복구 대기 | "live" 열려 있는 창 | "dead" 꺼진 세션
    this.userPicked = false;     // 사용자가 탭을 직접 눌렀으면 자동으로 탭을 바꾸지 않는다
    this.loaded = false;         // 첫 목록을 받았는지(복구 대기가 있으면 그 탭을 먼저 보여 주려고)
    this.ai = "all";             // 꺼진 세션 탭의 AI 거르기: all | claude | codex
    this.liveStatus = "all";     // 열려 있는 창 탭의 상태 거르기
    this.liveClosed = {};        // 접어 둔 공간 {공간이름: true}
    this.openGroups = {};        // 꺼진 세션 그룹을 사용자가 펼치거나 접은 상태 {그룹키: true|false}
    this.hoverKey = "";          // 마우스가 올라간 행(그 행에만 [ID 복사]를 보여 준다)
    this.confirm = "";           // "한 번 더 누르면 실행" 대기 중인 버튼 이름
    this.acting = false;         // 복구·빼기 실행 중(버튼 중복 클릭 방지)
    this.plan = null;            // 전부 복구 미리보기 {loading, items, done}
    this.planToken = 0;
    this.recovering = null;      // 전부 복구 진행 {total, at}
    this.firstAction = null;     // 검색창에서 Enter 를 누르면 실행할 "첫 결과"(render 가 갱신)
    this.busy = false;
    this.status = "불러오는 중…";
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "찾기: 제목 · 작업 이름 · 폴더 · AI · ID" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value().trim().toLowerCase();
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.enterFirst(cx));
    this.input.focus();
    cx.timer.after(400, () => this.input.focus());
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  dismiss() {
    closeOverlay(props().overlay);
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const [r, l, u] = await Promise.all([
          exec(NODE, [TOOL, "json", "--days", "14", "--limit", "60"]),
          exec(NODE, [TOOL, "last"]).catch(() => null),
          exec(NODE, [TOOL, "update-state"]).catch(() => null),
        ]);
        if (r.code !== 0) throw new Error((r.stderr || "목록 도구 실행 실패").trim());
        this.rows = JSON.parse(r.stdout);
        try { this.last = l && l.code === 0 && l.stdout ? JSON.parse(l.stdout) : null; } catch { this.last = null; }
        try { this.appUpd = u && u.code === 0 && u.stdout ? JSON.parse(u.stdout) : null; } catch { this.appUpd = null; }
        if (!this.loaded) {          // 처음 열었을 때: 복구할 작업이 있으면 그 탭부터 보여 준다
          this.loaded = true;
          if (!this.userPicked && this.rows.some((x) => !x.live && x.keeper && x.keeper.pending)) this.view = "pending";
        }
        if (!this.status.startsWith("✔") && !this.status.startsWith("✘") && !this.status.startsWith("복구 진행")) this.status = "";
        this.checkRecovering();
      } catch (e) {
        this.status = "목록을 불러오지 못했습니다: " + String((e && e.message) || e).slice(0, 160);
      }
      this.busy = false;
      cx.notify();
      if (this.recovering) cx.timer.after(FAST_MS, (cx) => this.refresh(cx));   // 복구 진행 중에는 자주 확인
    });
  }

  // 전부 복구가 진행 중이면 남은 개수로 상태 줄을 만들고, 끝났으면 알린다.
  remainingAuto() {
    return this.rows.filter((x) => !x.live && x.keeper && x.keeper.pending && !x.missing && x.keeper.addr && (x.keeper.attempts ?? 0) < MAX_ATTEMPTS).length;
  }
  checkRecovering() {
    if (!this.recovering) return;
    const left = this.remainingAuto();
    if (left === 0) { this.status = `✔ 전부 복구가 끝났습니다 (${this.recovering.total}개)`; this.recovering = null; }
    else if (Date.now() - this.recovering.at > RECOVER_WATCH_MS) { this.status = `복구가 오래 걸리고 있습니다 — 남은 ${left}개. 결과는 LAST-RESTORE.txt 에 기록됩니다.`; this.recovering = null; }
  }

  setHover(key, hovered, cx) {
    const next = hovered ? key : (this.hoverKey === key ? "" : this.hoverKey);
    if (next !== this.hoverKey) { this.hoverKey = next; cx.notify(); }
  }

  // 한 번 더 눌러야 실행되는 버튼(되돌리기 어려운 동작용). 5초 안에 다시 누르지 않으면 원래대로.
  ask(name, cx, fn) {
    if (this.confirm === name) { this.confirm = ""; cx.notify(); fn(); return; }
    this.confirm = name;
    cx.notify();
    cx.timer.after(5000, (cx) => { if (this.confirm === name) { this.confirm = ""; cx.notify(); } });
  }

  // sessions.mjs 의 명령 하나를 실행하고 결과를 한 줄로 알린다. 끝나면 목록을 다시 불러온다. onOk: 성공했을 때 추가로 할 일.
  runTool(args, startMsg, cx, onOk) {
    if (this.acting) return;
    this.acting = true;
    this.status = startMsg;
    cx.notify();
    cx.spawn(async (cx) => {
      let ok = false;
      let msg = "";
      try {
        const r = await exec(NODE, [TOOL, ...args, "--json"]);
        const o = JSON.parse(r.stdout || "{}");
        ok = !!o.ok;
        msg = o.message || (r.stderr || "알 수 없는 결과").trim();
      } catch (e) {
        msg = "도구를 실행하지 못했습니다: " + String((e && e.message) || e).slice(0, 160);
      }
      this.acting = false;
      this.status = (ok ? "✔ " : "✘ ") + msg;
      if (!ok) notify({ title: "처리하지 못했습니다", body: msg, level: "warning" });
      else if (onOk) onOk();
      cx.notify();
      this.refresh(cx);
      cx.timer.after(8000, (cx) => this.refresh(cx));        // 복구는 백그라운드로 진행되므로 몇 초 뒤 한 번 더 확인
      const shown = this.status;
      cx.timer.after(15000, (cx) => { if (this.status === shown) { this.status = ""; cx.notify(); } });
    });
  }

  // 꺼진 세션 하나를 새 탭에서 이어서 시작(sessions.mjs open). 성공하면 새 탭이 바로 보이도록 이 창은 닫는다.
  restore(item, cx) {
    if (!UUID.test(item.fullId)) return;
    this.status = `복구 중… ${item.idShort}`;
    cx.notify();
    cx.spawn(async (cx) => {
      let ok = false;
      let msg = "";
      try {
        const r = await exec(NODE, [TOOL, "open", item.fullId, "--json"]);
        const o = JSON.parse(r.stdout || "{}");
        ok = !!o.ok;
        msg = o.message || (r.stderr || "알 수 없는 결과").trim();
      } catch (e) {
        msg = "복구 도구를 실행하지 못했습니다: " + String((e && e.message) || e).slice(0, 160);
      }
      notify({ title: ok ? "세션 복구" : "복구하지 못했습니다", body: msg, level: ok ? "success" : "warning" });
      this.status = (ok ? "✔ " : "✘ ") + msg;
      if (ok) this.dismiss();      // 새 탭이 바로 보이도록 이 창은 닫는다
      else cx.notify();
    });
  }

  // 복구 대기 항목 하나: 키퍼에게 맡길 수 있으면(빈 셸에 입력 / 같은 공간에 새 탭) 그렇게, 아니면 새 탭 열기.
  recoverOne(item, cx) {
    if (canAutoRecover(item)) this.runTool(["recover", item.keeper.addr], `복구를 시작하는 중… ${item.keeper.addr}`, cx);
    else this.restore(item, cx);
  }

  recoverAll(cx) {
    const total = this.remainingAuto();
    this.plan = null;
    this.planToken++;
    this.runTool(["recover", "all"], "전부 복구를 시작하는 중…", cx, () => {
      this.recovering = { total, at: Date.now() };
      this.status = `복구 진행 중 — 창이 3개씩 열립니다(몇 분 걸릴 수 있고, 이 창은 닫아도 됩니다)`;
    });
  }

  // 전부 복구 미리보기: 키퍼 -Plan 을 백그라운드로 돌리고 2초마다 결과를 읽는다(최대 45초). 아무것도 바꾸지 않는다.
  startPlan(cx) {
    if (this.acting || (this.plan && this.plan.loading)) return;   // 계산 중에 연타하면 같은 결과 파일에 동시에 쓰게 되므로 무시한다(실제 로그에서 3초 안에 3번 실행된 것 확인)
    const token = ++this.planToken;
    this.plan = { loading: true, items: [], done: false, at: Date.now() };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec(NODE, [TOOL, "plan", "start", "--json"]);
        const o = JSON.parse(r.stdout || "{}");
        if (!o.ok) throw new Error(o.message || "미리보기를 시작하지 못했습니다");
      } catch (e) {
        if (token === this.planToken) { this.plan = null; this.status = "✘ " + String((e && e.message) || e).slice(0, 140); cx.notify(); }
        return;
      }
      this.pollPlan(token, cx);
    });
  }
  pollPlan(token, cx) {
    cx.timer.after(2000, (cx) => {
      if (token !== this.planToken || !this.plan) return;
      cx.spawn(async (cx) => {
        let res = null;
        try { const r = await exec(NODE, [TOOL, "plan", "read"]); res = JSON.parse(r.stdout || "{}"); } catch { res = null; }
        if (token !== this.planToken || !this.plan) return;
        const timedOut = Date.now() - this.plan.at > 45000;
        if (res && (res.done || timedOut)) this.plan = { loading: false, items: res.items || [], done: !!res.done };
        else if (timedOut) this.plan = { loading: false, items: [], done: false };
        cx.notify();
        if (this.plan.loading) this.pollPlan(token, cx);
      });
    });
  }

  forget(item, cx) {
    if (!UUID.test(item.fullId)) return;
    this.runTool(["forget", item.fullId], "복구 목록에서 제외하는 중… (몇 초 걸립니다)", cx);
  }

  forgetOld(cx) {
    this.plan = null;
    this.planToken++;
    this.runTool(["forget-old"], "옛 항목을 복구 목록에서 제외하는 중… (백업을 만들고 몇 초 걸립니다)", cx);
  }

  // Herdr 앱 업데이트 적용(키퍼가 백업 -> 파일 교체 -> 검증 후 창만 껐다 켠다. 터미널은 코어가 유지). 이 창도 함께 닫힙니다.
  applyAppUpdate(cx) {
    this.runTool(["update"], "Herdr 앱 업데이트를 시작하는 중… (창이 잠깐 닫혔다 다시 열립니다)", cx);
  }

  toggleAutoUpdate(cx) {
    const turnOn = !(this.appUpd && this.appUpd.auto !== false);
    this.runTool(["update-auto", turnOn ? "on" : "off"], turnOn ? "앱 자동 업데이트를 켜는 중…" : "앱 자동 업데이트를 끄는 중…", cx);
  }

  goTo(item) {
    if (!item.addr) return;
    run("agent.focus", { terminal: item.addr });
    this.dismiss();
  }

  // 클립보드에 글자를 넣는다. text 는 model.js 가 UUID 로 검증한 ID 또는 resumeCommand(고정 글자 + 검증된 ID)만 받는다(따옴표 등 셸 문자가 들어올 수 없다).
  copyText(text, okMsg, cx) {
    if (!text || /['"`$;&|<>\r\n]/.test(text)) return;
    cx.spawn(async (cx) => {
      try {
        await exec("powershell.exe", ["-NoProfile", "-Command", `Set-Clipboard -Value '${text}'`]);
        this.status = okMsg;
      } catch (e) {
        this.status = "✘ 복사하지 못했습니다";
      }
      cx.notify();
    });
  }

  copyId(item, cx) {
    if (!UUID.test(item.fullId)) return;
    this.copyText(item.fullId, `✔ 전체 ID를 복사했습니다: ${item.fullId}`, cx);
  }

  // [명령 복사]: claude --resume <ID> / codex resume <ID> 한 줄을 복사한다(터미널에 바로 붙여 넣어 이어서 시작).
  copyCmd(item, cx) {
    const cmd = resumeCommand(item);
    if (cmd) this.copyText(cmd, `✔ 명령을 복사했습니다: ${cmd}`, cx);
  }

  // ID 를 못 찾은 창의 [ID 확인 불가] 칩을 누르면 이유를 상태줄에 보여 준다
  explainNoId(item, cx) {
    this.status = idChip(item).why;
    cx.notify();
  }

  // 검색창에서 Enter: 검색어가 있을 때만, 지금 탭의 첫 결과에 대해 그 행의 주 버튼(복구 / 이 창으로 이동)과 같은 일을 한다.
  enterFirst(cx) {
    const a = this.firstAction;
    if (!this.filter || !a) return;
    if (a.view === "pending") this.recoverOne(a.item, cx);
    else if (a.view === "live") this.goTo(a.item);
    else this.restore(a.item, cx);
  }

  render() {
    const t = theme();
    const { live, pending, dead } = buildItems(this.rows, agents(), { home: home() });
    const f = this.filter;
    const liveShown = filterLive(live.filter((x) => matchItem(x, f)), this.liveStatus);
    const liveGroups = groupLive(liveShown);
    const counts = liveSummary(live);
    const pendingShown = pending.filter((x) => matchItem(x, f));
    const pGroups = groupPending(pendingShown);
    const groups = groupDead(filterAi(dead, this.ai), { filter: f, openOverrides: this.openGroups, home: home() });
    const openKey = keys().find((k) => k.action === "mod.open:session-keeper")?.keys;
    const autoCount = pending.filter(canAutoRecover).length;
    const manualCount = pending.filter((x) => x.keeper?.auto === false).length;   // 닫히기 직전이 아니어서 자동 복구에서 빠지는 옛 항목(직접 [복구])
    const planByAddr = new Map((this.plan && this.plan.items ? this.plan.items : []).map((p) => [p.addr, p]));

    // 검색창 Enter 가 실행할 "첫 결과"
    const firstLive = liveGroups.find((g) => !this.liveClosed[g.key] || f)?.items[0];
    const firstDead = groups.find((g) => g.open)?.items[0];
    this.firstAction = this.view === "pending" ? (pGroups[0]?.items[0] ? { view: "pending", item: pGroups[0].items[0] } : null)
      : this.view === "live" ? (firstLive ? { view: "live", item: firstLive } : null)
        : (firstDead ? { view: "dead", item: firstDead } : null);

    // ---- 작은 부품
    const btn = (id, label, onClick, primary) =>
      h_flex()
        .id(id)
        .h(26)
        .px(10)
        .flex_none()
        .items_center()
        .rounded(6)
        .text_size(12)
        .cursor_pointer()
        .bg(primary ? t.solid : t.raised)
        .text_color(primary ? t.solid_foreground : t.foreground)
        .hover((s) => (primary ? s.bg(t.accent).text_color(t.accent_foreground) : s.bg(t.hover)))
        .on_click(onClick)
        .child(label);

    const pill = (label, color) => div().flex_none().px(6).py(1).rounded(5).bg(t.raised).text_size(12).text_color(color ?? t.muted).child(label);
    const cell = (w, el) => div().w(w).flex_none().min_w(0).child(el);

    // 모든 행에 항상 보이는 ID 칩: 누르면 전체 ID 복사 (마우스를 올릴 필요 없음). ID 를 못 찾았으면 "ID 확인 불가" - 누르면 이유를 보여 준다.
    const idChipEl = (x) => {
      const c = idChip(x);
      return h_flex()
        .id(`id-${x.key}`)
        .h(24)
        .px(8)
        .flex_none()
        .items_center()
        .rounded(6)
        .text_size(12)
        .cursor_pointer()
        .bg(t.raised)
        .text_color(c.ok ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => (c.ok ? this.copyId(x, cx) : this.explainNoId(x, cx)))
        .child(c.label);
    };
    // 마우스를 올린 행에만 보이는 [명령 복사] (claude --resume <ID> / codex resume <ID>)
    const copyBtn = (x) => (this.hoverKey === x.key && resumeCommand(x) ? btn(`cp-${x.key}`, "명령 복사", (_e, cx) => this.copyCmd(x, cx), false) : null);

    const rowBase = (x) =>
      h_flex()
        .id(x.key)
        .h(ROW_H)
        .gap(10)
        .px(10)
        .items_center()
        .rounded(8)
        .hover((s) => s.bg(t.hover))
        .on_hover((hovered, cx) => this.setHover(x.key, hovered, cx));

    // 열려 있는 창: [상태] [탭 이름] [제목] [AI] [이동]
    const liveRow = (x) => {
      const st = STATUS[x.status];
      const color = t[x.status] ?? t.idle;
      return rowBase(x)
        .child(h_flex().w(78).flex_none().gap(6).items_center().child(div().text_size(13).text_color(color).child("●")).child(div().text_size(12).text_color(x.status === "blocked" ? color : t.muted).child(st ? st.word : "열림")))
        .child(cell(230, div().truncate().text_size(13.5).font_semibold().text_color(t.foreground).child(x.tab || x.title)))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.muted).child(x.tab ? x.title : ""))
        .child(pill(x.ai, aiColor(x.ai)))
        .child(idChipEl(x))
        .when(this.hoverKey === x.key && !!resumeCommand(x), (el) => el.child(copyBtn(x)))
        .child(x.addr ? btn(`go-${x.key}`, "이 창으로 이동", () => this.goTo(x), true) : div().w(60).flex_none().text_size(12).text_color(t.muted).child("열림"));
    };

    // 꺼진 세션: [꺼짐] [제목] [AI] [폴더] [시간] [복구]
    const deadRow = (x) =>
      rowBase(x)
        .child(h_flex().w(78).flex_none().gap(6).items_center().child(div().text_size(13).text_color(t.muted).child("○")).child(div().text_size(12).text_color(t.muted).child("꺼짐")))
        .child(div().flex_1().min_w(0).truncate().text_size(13.5).font_semibold().text_color(t.foreground).child(x.title))
        .when((x.dups ?? 0) > 0, (el) => el.child(pill(`비슷한 세션 +${x.dups}`)))
        .child(pill(x.ai, aiColor(x.ai)))
        .child(idChipEl(x))
        .child(cell(170,div().truncate().text_size(12).text_color(t.muted).child([x.model, (x.where || "").includes(" / ") ? x.where : ""].filter(Boolean).join(" · "))))   // 폴더 이름은 그룹 제목과 같아서 모델·창 이름을 보여 준다
        .child(div().w(64).flex_none().text_size(12).text_color(t.muted).child(ago(x.sortAt)))
        .when(this.hoverKey === x.key && !!resumeCommand(x), (el) => el.child(copyBtn(x)))
        .child(btn(`rs-${x.key}`, "복구", (_e, cx) => this.restore(x, cx), true));

    // 복구 대기: [상태] [작업 이름] [대화 제목] [AI] [시도/계획] [확인 시각] [복구] [빼기] (+ 설명 줄)
    const pendingRow = (x) => {
      const ps = pendingState(x);
      const toneColor = ps.tone === "wait" ? t.muted : t.blocked;
      const forgetName = `forget-${x.key}`;
      const tabName = x.keeper?.tab ? x.keeper.tab.replace(/\b\d\dy_\d\dm_\d\dd_/g, "") : "";
      const numericTab = /^\d{1,3}$/.test(tabName);
      const headline = tabName && !numericTab ? tabName : (x.missing ? x.where || x.title : x.title);
      const showTitle = !x.missing && headline !== x.title;
      const pl = planByAddr.get(x.keeper?.addr);
      const top = h_flex()
        .h(ROW_H)
        .gap(10)
        .items_center()
        .child(h_flex().w(112).flex_none().gap(6).items_center().child(div().text_size(13).text_color(toneColor).child("●")).child(div().text_size(12).text_color(toneColor).child(ps.word)))
        // 작업 이름 칸: 넓은 창에서는 230px, 좁은 창(ID 칩이 늘어 폭이 모자랄 때)에서는 110px 까지 줄어 오른쪽 [복구]·[목록에서 제외]가 잘리지 않게 한다
        .child(div().flex_1().min_w(110).max_w(230).truncate().text_size(13.5).font_semibold().text_color(t.foreground).child(headline))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.muted).child(showTitle ? x.title : ""))
        .when(numericTab, (el) => el.child(pill(`탭 ${tabName}`)))
        .when((x.keeper?.attempts ?? 0) > 0, (el) => el.child(pill(`자동 시도 ${x.keeper.attempts}/${MAX_ATTEMPTS}`, t.blocked)))
        .when(!!pl, (el) => el.child(pill(`→ ${planWord(pl)}`, pl && pl.action === "SKIP" ? t.blocked : t.foreground)))
        .child(pill(x.ai, aiColor(x.ai)))
        .child(idChipEl(x))
        .when(this.hoverKey === x.key && !!resumeCommand(x), (el) => el.child(copyBtn(x)))
        .when(!pl, (el) => el.child(div().w(92).flex_none().text_size(12).text_color(t.muted).child(x.keeper?.seenMs ? `확인 ${ago(x.keeper.seenMs)}` : "")))   // 미리보기 표시(→ …)가 있는 행은 폭이 모자라서 "확인 시각"을 숨긴다(버튼이 잘리지 않게)
        .child(x.missing ? div().w(44).flex_none() : btn(`rc-${x.key}`, "복구", (_e, cx) => this.recoverOne(x, cx), true))   // 복구 불가여도 자리를 비워 둬 오른쪽 열이 어긋나지 않게
        .child(btn(`fg-${x.key}`, this.confirm === forgetName ? "한 번 더 누르면 제외합니다" : "목록에서 제외", (_e, cx) => this.ask(forgetName, cx, () => this.forget(x, cx)), false));
      return v_flex()
        .id(x.key)
        .px(10)
        .rounded(8)
        .hover((s) => s.bg(t.hover))
        .on_hover((hovered, cx) => this.setHover(x.key, hovered, cx))   // 복구 대기 행에도 [명령 복사]가 보이게
        .child(top)
        .when(!!ps.why, (el) => el.child(div().pb(6).pl(122).truncate().text_size(12).text_color(toneColor).child(ps.why)));
    };

    const groupBar = (id, label, count, extra, closed, onClick) =>
      h_flex()
        .id(id)
        .gap(8)
        .px(10)
        .h(30)
        .mt(4)
        .items_center()
        .rounded(7)
        .bg(t.raised)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(onClick)
        .child(div().w(14).flex_none().text_color(t.muted).child(closed ? "▸" : "▾"))
        .child(div().font_semibold().text_size(13).text_color(t.foreground).child(label))
        .child(div().text_size(12).text_color(t.muted).child(`${count}개`))
        .child(extra ?? div());

    const tabBtn = (id, label, which, badge) =>
      btn(id, h_flex().gap(6).items_center().child(div().child(label)).when(!!badge, (el) => el.child(div().text_color(t.blocked).child(badge))), (_e, cx) => { this.view = which; this.userPicked = true; cx.notify(); }, this.view === which);

    const chip = (id, label, selected, onClick) => btn(id, label, onClick, selected);

    // ---- 위쪽 1줄: 제목 · 탭 · 검색 · 새로고침
    const topRow = h_flex()
      .gap(8)
      .items_center()
      .child(div().text_size(15).font_bold().text_color(t.foreground).child("세션키퍼"))
      .child(div().w(6).flex_none())
      .child(tabBtn("cs-tab-pending", `복구 대기 (${pending.length})`, "pending", pending.length > 0 ? "●" : ""))
      .child(tabBtn("cs-tab-live", `열려 있는 창 (${live.length})`, "live", counts.blocked > 0 ? `● ${counts.blocked}` : ""))
      .child(tabBtn("cs-tab-dead", `꺼진 세션 (${dead.length})`, "dead", ""))
      .child(div().flex_1().min_w(0))
      // 검색창: 고정 폭이면 좁은 창에서 [새로고침]이 잘렸다(1000px·760px 창에서 확인) -> 남는 폭에 맞춰 줄어든다
      .child(h_flex().flex_1().min_w(56).max_w(360).h(30).px(10).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background).child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
      .child(btn("cs-refresh", "새로고침", (_e, cx) => this.refresh(cx), false));

    // ---- 위쪽 2줄: 탭별 도구줄
    let tools;
    if (this.view === "pending") {
      const left = this.remainingAuto();
      const planText = this.plan ? (this.plan.loading ? "미리보기를 계산하는 중…" : (this.plan.done ? `미리보기: ${planSummary(this.plan.items)}` : "미리보기 결과가 없습니다(복구할 작업이 없거나 시간이 초과되었습니다)")) : "";
      tools = h_flex()
        .gap(8)
        .items_center()
        .child(
          this.recovering
            ? div().text_size(12.5).font_semibold().text_color(t.foreground).child(`복구 진행 중 — 남은 ${left}개 / ${this.recovering.total}개`)
            : autoCount > 0
              ? btn("cs-recover-all", this.confirm === "all" ? `한 번 더 누르면 ${autoCount}개를 모두 복구합니다` : `전부 복구 (${autoCount})`, (_e, cx) => this.ask("all", cx, () => this.recoverAll(cx)), true)
              : div().text_size(12).text_color(t.muted).child("자동으로 복구할 수 있는 작업이 없습니다."),
        )
        .when(autoCount > 0 && !this.recovering, (el) => el.child(btn("cs-plan", "미리보기", (_e, cx) => this.startPlan(cx), false)))
        // 예전에 닫혀 목록에 남은 항목(자동 복구에서 빠지는 것)을 한꺼번에 뺀다. 두 번 눌러야 실행되고, 키퍼가 지우기 전에 백업을 만든다(대화 기록은 그대로).
        .when(manualCount > 0 && !this.recovering, (el) => el.child(btn("cs-forget-old", this.confirm === "old" ? `한 번 더 누르면 옛 항목 ${manualCount}개를 제외합니다` : `옛 항목 ${manualCount}개 제외`, (_e, cx) => this.ask("old", cx, () => this.forgetOld(cx)), false)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(planText || (manualCount > 0 ? `자동 복구 대상 ${pending.length - manualCount}개(닫히기 직전 창) · 직접 복구 ${manualCount}개(예전에 닫힌 항목)` : "빈 창으로 돌아온 곳에는 거기에 이어서 입력하고, 닫힌 창은 같은 공간에 새 탭으로 엽니다.")));
    } else if (this.view === "live") {
      tools = h_flex()
        .gap(6)
        .items_center()
        .child(chip("cs-st-all", `전체 ${live.length}`, this.liveStatus === "all", (_e, cx) => { this.liveStatus = "all"; cx.notify(); }))
        .children(STATUS_KEYS.map((k) => chip(`cs-st-${k}`, `${STATUS_LABEL[k]} ${counts[k]}`, this.liveStatus === k, (_e, cx) => { this.liveStatus = this.liveStatus === k ? "all" : k; cx.notify(); })))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child("숫자를 누르면 그 상태의 창만 봅니다. 다시 누르면 전체."));
    } else {
      tools = h_flex()
        .gap(6)
        .items_center()
        .child(div().text_size(12).text_color(t.muted).child("AI"))
        .child(chip("cs-ai-all", "전체", this.ai === "all", (_e, cx) => { this.ai = "all"; cx.notify(); }))
        .child(chip("cs-ai-claude", "Claude", this.ai === "claude", (_e, cx) => { this.ai = "claude"; cx.notify(); }))
        .child(chip("cs-ai-codex", "Codex", this.ai === "codex", (_e, cx) => { this.ai = "codex"; cx.notify(); }))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(f ? "검색 중에는 비슷한 세션도 전부 보입니다." : "자동 복구 대상이 아닌 꺼진 세션입니다. 같은 제목은 하나로 접혔습니다."));
    }

    // ---- 결과 한 줄: 복구 대기 탭에서는 항상, 다른 탭에서는 확인이 필요할 때만
    const banner = lastBanner(this.last);
    const bannerColor = banner.level === "ok" ? t.done : banner.attention ? t.blocked : t.muted;
    const bannerEl = (this.view === "pending" || banner.attention)
      ? h_flex().gap(8).px(10).h(26).items_center().rounded(7).bg(t.raised)
        .child(div().flex_none().text_size(12).text_color(bannerColor).child("●"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(banner.detail && banner.level !== "none" ? `${banner.text}  —  ${banner.detail}` : banner.text))
      : null;

    // ---- Herdr 앱 업데이트 한 줄(새 버전이 대기 중이거나 자동 업데이트가 꺼져 있을 때만). 적용은 두 번 눌러야 하고, 자동 켜기/끄기도 여기서 한다.
    const upd = appUpdateLine(this.appUpd);
    const updEl = upd
      ? h_flex().gap(8).px(10).h(30).items_center().rounded(7).bg(t.raised)
        .child(div().flex_none().text_size(12).text_color(upd.apply ? t.blocked : t.muted).child("●"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(upd.text))
        .when(upd.apply && !this.recovering, (el) => el.child(btn("cs-app-update", this.confirm === "appupd" ? "한 번 더 누르면 Herdr 창이 잠깐 닫혔다 열립니다" : "앱 업데이트", (_e, cx) => this.ask("appupd", cx, () => this.applyAppUpdate(cx)), true)))
        .child(btn("cs-app-auto", upd.auto ? "자동 업데이트: 켜짐" : "자동 업데이트: 꺼짐", (_e, cx) => this.toggleAutoUpdate(cx), false))
      : null;

    // ---- 목록
    let rowsOut;
    let empty;
    if (this.view === "pending") {
      rowsOut = pGroups.flatMap((g) => [groupBar(`pg-${g.key || "none"}`, g.label, g.count, null, false, () => {}), ...g.items.map(pendingRow)]);
      empty = pendingShown.length === 0;
    } else if (this.view === "live") {
      rowsOut = liveGroups.flatMap((g) => {
        const closed = !!this.liveClosed[g.key] && !f;
        const extra = g.blocked > 0 ? div().text_size(12).font_semibold().text_color(t.blocked).child(`승인 대기 ${g.blocked}`) : null;
        return [groupBar(`lg-${g.key || "none"}`, g.label, g.count, extra, closed, (_e, cx) => { this.liveClosed = { ...this.liveClosed, [g.key]: !this.liveClosed[g.key] }; cx.notify(); }), ...(closed ? [] : g.items.map(liveRow))];
      });
      empty = liveShown.length === 0;
    } else {
      rowsOut = groups.flatMap((g) => [
        groupBar(`cg-${g.key || "none"}`, g.label, g.count, div().flex_1().flex().justify_end().child(div().text_size(12).text_color(t.muted).child(`마지막 사용 ${ago(g.latest)}`)), !g.open, (_e, cx) => { this.openGroups = { ...this.openGroups, [g.key]: !g.open }; cx.notify(); }),
        ...(g.open ? g.items.map(deadRow) : []),
      ]);
      empty = groups.length === 0;
    }
    const emptyText = this.view === "pending" && !f
      ? "복구할 작업이 없습니다 ✔  창이 닫히거나 컴퓨터가 꺼져도 작업은 여기에 모였다가 Herdr를 켜면 자동으로 되살아납니다."
      : this.view === "live" && !f && this.liveStatus !== "all" ? `${STATUS_LABEL[this.liveStatus]} 상태인 창이 없습니다.` : "조건에 맞는 세션이 없습니다.";

    const footer = this.status || `Esc 닫기  ·  Ctrl+1/2/3 탭 바꾸기  ·  검색 후 Enter = 첫 결과 ${this.view === "live" ? "창으로 이동" : "복구"}  ·  열기: ${openKey ? openKey : "Ctrl+Shift+P → mod.open session-keeper"}`;

    return v_flex()
      .id("cs-root")
      .track_focus(this.handle)
      .size_full()
      .px(14)
      .py(12)
      .gap(8)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          this.dismiss();
          cx.stop_propagation();
        } else if (e.keystroke === "ctrl-1" || e.keystroke === "ctrl-2" || e.keystroke === "ctrl-3") {
          this.view = { "ctrl-1": "pending", "ctrl-2": "live", "ctrl-3": "dead" }[e.keystroke];
          this.userPicked = true;
          cx.notify();
          cx.stop_propagation();
        }
      })
      .child(topRow)
      .child(tools)
      .when(!!bannerEl, (el) => el.child(bannerEl))
      .when(!!updEl, (el) => el.child(updEl))
      .child(
        v_flex()
          .id("cs-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .children(rowsOut)
          .when(empty && !this.busy, (el) => el.child(div().p(20).text_size(13).text_color(t.muted).child(emptyText))),
      )
      .child(div().h(18).text_size(12).text_color(t.muted).truncate().child(footer));
  }
}
