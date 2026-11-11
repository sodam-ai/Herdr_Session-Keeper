// 프로세스 계보(누가 누구의 부모인지). 실행 중인 세션이 어느 Herdr 창의 셸 아래에서 돌고 있는지 정확히 알아내는 데 쓴다.
// 1순위: Windows 기본 프로세스 목록 API(Toolhelp32) — 새 PowerShell 포함 약 0.6초.
// 2순위(1순위가 막힌 환경): WMI(Get-CimInstance) — 약 1.5초.
import { execFile } from 'node:child_process';

const TOOLHELP_CS = `using System; using System.Runtime.InteropServices; using System.Text;
public static class PS {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct PE { public uint size, usage, pid; public IntPtr heap; public uint module, threads, ppid; public int pri; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint f, uint p);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr s, ref PE e);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr s, ref PE e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string Dump() { var sb = new StringBuilder(); IntPtr s = CreateToolhelp32Snapshot(2, 0); var e = new PE(); e.size = (uint)Marshal.SizeOf(typeof(PE));
    if (Process32FirstW(s, ref e)) { do { sb.Append(e.pid).Append('|').Append(e.ppid).Append('|').Append(e.exe).Append('\\n'); } while (Process32NextW(s, ref e)); } CloseHandle(s); return sb.ToString(); }
}`;
const TOOLHELP_SCRIPT = `Add-Type -TypeDefinition @'\n${TOOLHELP_CS}\n'@\n[Console]::Out.Write([PS]::Dump())`;
const WMI_SCRIPT = "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId,$_.ParentProcessId,$_.Name }";

export const SCRIPTS = { toolhelp: TOOLHELP_SCRIPT, wmi: WMI_SCRIPT };   // 시험·성능 비교용

export function runScript(script, timeout) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout, windowsHide: true, maxBuffer: 1 << 25, encoding: 'utf8' }, (err, stdout) => {
      resolve(parseDump(err && !stdout ? '' : stdout));
    });
  });
}

// "pid|ppid|이름" 줄들 -> Map<pid, {ppid, name}>
export function parseDump(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^(\d+)\|(\d+)\|(.*)$/.exec(line.trim());
    if (m) map.set(Number(m[1]), { ppid: Number(m[2]), name: m[3] });
  }
  return map;
}

// ---- Codex: `codex resume <ID>` 로 켠 창은 프로세스 명령줄에 대화 ID 가 그대로 있다(창 제목은 "PC" 등이라 믿을 수 없다).
// Toolhelp 는 명령줄을 주지 않으므로 node.exe / codex.exe 만 WMI 로 따로 읽는다(전체 목록보다 훨씬 작다).
const CODEX_CMD_SCRIPT = "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='codex.exe'\" | ForEach-Object { '{0}|{1}' -f $_.ProcessId,$_.CommandLine }";
const RESUME_RE = /(?:^|[\s"\\/])codex(?:\.js|\.exe)?"?\s+resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|"|$)/i;

// "pid|명령줄" 줄들 -> Map<pid, 대화ID>  (resume <UUID> 가 없는 프로세스는 빠진다)
export function parseResumeDump(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^(\d+)\|(.*)$/.exec(line.trim());
    if (!m) continue;
    const r = RESUME_RE.exec(m[2]);
    if (r) map.set(Number(m[1]), r[1].toLowerCase());
  }
  return map;
}

export function codexResumeSnapshot(timeout = 8000) {
  if (process.env.SESSIONS_NO_HERDR) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', CODEX_CMD_SCRIPT], { timeout, windowsHide: true, maxBuffer: 1 << 25, encoding: 'utf8' }, (err, stdout) => resolve(parseResumeDump(err && !stdout ? '' : stdout)));
  });
}

// 반환: Promise<Map<pid, {ppid, name}>>  (모두 실패/시간 초과/SESSIONS_NO_HERDR 이면 빈 Map → 호출한 쪽이 보조 정보로 대신한다)
export async function processSnapshot(timeout = 8000) {
  if (process.env.SESSIONS_NO_HERDR) return new Map();
  const fast = await runScript(TOOLHELP_SCRIPT, timeout);
  return fast.size > 0 ? fast : runScript(WMI_SCRIPT, timeout);
}
