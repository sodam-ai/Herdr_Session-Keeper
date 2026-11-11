// Herdr 와의 연결: 열려 있는 창 목록(hc), 화면 이동·새 탭 열기(herdr-app).
import { execFile, spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const herdrApp = () => process.env.KEEPER_APP_EXE || join(process.env.LOCALAPPDATA || '', 'Programs', 'herdr-app', 'herdr-app.exe');

function run(cmd, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 24, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' }));
  });
}
const parse = (s) => { try { return JSON.parse(String(s).replace(/^﻿/, '')); } catch { return null; } };

// 지금 Herdr 에 떠 있는 창들: 주소·이름·AI 종류·창 제목·셸 pid. (읽기 전용. SESSIONS_NO_HERDR=1 이면 건너뜀)
export async function herdrWindows() {
  if (process.env.SESSIONS_NO_HERDR) return [];
  const ls = parse((await run('hc', ['ls', '--json'])).stdout);
  const terms = (ls?.terminals || []).filter((t) => t.state === 'live' && t.address);
  const details = await Promise.all(terms.map((t) => run('hc', ['get', t.address, '--json'])));
  return terms.map((t, i) => {
    const g = parse(details[i].stdout) || {};
    return {
      addr: t.address, agent: t.agent || '', where: t.where || g.labels?.where || '', status: t.status || '',
      title: g.title || '', shellPid: Number(g.pid) || 0, fgPid: Number(g.foreground?.pid) || 0,
    };
  });
}

// 실행 중인 세션의 창으로 화면만 옮긴다 (입력/종료 없음)
export function focusWindow(addr) {
  const r = spawnSync(herdrApp(), ['do', 'agent.focus', JSON.stringify({ terminal: addr })], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  return { ok: r.status === 0, detail: (r.stderr || r.stdout || '').trim().slice(0, 200) };
}

// Herdr 앱에 새 탭을 연다. spec: {argv, folder, place, name}
export function openTab(spec) {
  const r = spawnSync(herdrApp(), ['do', 'terminal.open', JSON.stringify(spec)], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (r.status !== 0) return { ok: false, detail: (r.stderr || r.stdout || '').trim().slice(0, 300) };
  return { ok: true, ...(parse(r.stdout) || {}) };
}
