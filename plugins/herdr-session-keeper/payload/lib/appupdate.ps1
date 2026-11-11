# lib/appupdate.ps1 - Herdr 앱 업데이트를 "Herdr 가 열려 있어도" 적용한다 (session-keeper.ps1 이 점으로 불러 쓴다).
#
# 왜 필요한가(2026-11-11 실측, herdr-app 0.1.14):
#   앱은 새 버전을 <설치폴더>.new 에 받아 두고, 재시작/종료 때 "설치 폴더 이름 바꾸기"(herdr-app -> .old, .new -> herdr-app)로 교체한다.
#   그런데 Windows 는 "어떤 프로세스의 현재 작업 폴더(cwd)로 쓰이는 폴더"의 이름을 바꿀 수 없다. 이 PC 에서는 앱 1 + 코어 4 + 터미널 콘솔 호스트(OpenConsole) 34 개가
#   설치 폴더를 cwd 로 잡고 있어, 터미널이 하나라도 살아 있으면 교체가 영원히 실패한다(그래서 0.1.15 가 받아져 있는데도 못 깔림).
#   상류(herdr-app) 0.1.15 가 "Windows: 설치 폴더에서 시작해도 업데이트가 적용됨"(#673)을 고쳤지만, 0.1.15 를 깔려면 이 버그를 먼저 넘어야 한다.
# 해결: 폴더 이름을 바꾸지 않고 "폴더 안의 파일"을 바꾼다. 실행 중인 exe 도 파일 이름은 바꿀 수 있다(실측: hc.exe.old-... 도 같은 방식).
#   전체 백업 -> 파일별 [이름 바꾸기 + 복사] -> 해시·버전 검증 -> 하나라도 틀리면 전부 원복 -> (선택) 창만 재시작(터미널은 코어가 유지).
# 이 파일은 파일 교체 중 어떤 터미널·코어·세션도 건드리지 않는다. 창 재시작도 사용자가 시키거나(-Mode Update) 자동 허용 파일이 있을 때만 한다.

$AppUpdStateFile = Join-Path $Dir 'session-keeper.appupdate.json'      # 화면(모드)이 읽는 상태
$AppUpdMarker    = Join-Path $Dir 'session-keeper.appupdate.marker'    # "지금 앱을 일부러 껐다 켜는 중" 표식(키퍼가 이를 사고로 오인하지 않게)
$AppUpdOffFile   = Join-Path $Dir 'session-keeper.appupdate.off'       # 이 파일이 있으면 자동 업데이트를 하지 않는다(기본: 없음 = 켜짐). 켜기/끄기: -Mode Update -Auto On|Off
$AppUpdIdleFile  = Join-Path $Dir 'session-keeper.appupdate.idle'      # 이 파일이 있으면(그리고 자동이 켜져 있으면) 앱이 켜진 채로도 모두 한가할 때 적용한다(기본: 없음)
$AppUpdLogDir    = $Dir

function Test-AppAutoUpdate { return -not (Test-Path -LiteralPath $AppUpdOffFile) }
# -Mode Update -Auto On|Off|Status
function Set-AppAutoUpdate([string]$Value) {
    switch ($Value) {
        'On'  { Remove-TempFile $AppUpdOffFile; Write-Log '앱 자동 업데이트: 켬'; Write-Host '앱 자동 업데이트를 켰습니다(Herdr 가 켜지는 순간 새 버전이 받아져 있으면 적용).' }
        'Off' { try { [IO.File]::WriteAllText($AppUpdOffFile, "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')") } catch {}; Write-Log '앱 자동 업데이트: 끔'; Write-Host '앱 자동 업데이트를 껐습니다. 필요할 때만 -Mode Update 로 직접 적용합니다.' }
        default { Write-Host ("앱 자동 업데이트: " + $(if (Test-AppAutoUpdate) { '켜짐' } else { '꺼짐' }) + " / 앱이 켜진 채 한가할 때 적용: " + $(if (Test-Path -LiteralPath $AppUpdIdleFile) { '켜짐' } else { '꺼짐(기본)' })) }
    }
}

function Get-AppInstallDir { if ($env:KEEPER_APP_DIR) { return $env:KEEPER_APP_DIR }; return (Split-Path -Parent $AppExe) }

# 프로그램을 시간 제한으로 실행해 표준출력을 돌려준다(멈추면 강제 종료). 반환: @{ ok; code; out }
function Invoke-Exe([string]$Path, [string[]]$ExeArgs, [int]$TimeoutSec = 20) {
    try {
        $psi = New-Object Diagnostics.ProcessStartInfo
        $psi.FileName = $Path; $psi.Arguments = (@($ExeArgs | ForEach-Object { ConvertTo-WinArg "$_" }) -join ' ')
        $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
        $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
        $p = [Diagnostics.Process]::Start($psi)
        $so = $p.StandardOutput.ReadToEndAsync(); $null = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit($TimeoutSec * 1000)) { try { $p.Kill() } catch {}; return @{ ok = $false; code = -1; out = '' } }
        return @{ ok = ($p.ExitCode -eq 0); code = $p.ExitCode; out = "$($so.Result)".Trim() }
    } catch { return @{ ok = $false; code = -2; out = "$($_.Exception.Message)" } }
}

# "herdr-app 0.1.15" -> '0.1.15' (읽지 못하면 $null)
function Get-ExeVersion([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $r = Invoke-Exe $Path @('--version') 15
    if ($r.ok -and $r.out -match 'herdr-app\s+(\d+\.\d+\.\d+)') { return $Matches[1] }
    return $null
}

function Test-NewerVersion([string]$A, [string]$B) {
    try { return ([version]$A) -gt ([version]$B) } catch { return $false }
}

# 받아 둔 새 버전: <설치폴더>.new + 영수증 <설치폴더>.new.json. 영수증 버전과 실제 exe 버전이 같아야 믿는다(앱 자신의 규칙과 같다).
function Get-AppStaged([string]$Dir) {
    $stage = "$Dir.new"; $receipt = "$Dir.new.json"
    $r = @{ dir = $stage; receipt = $receipt; ver = $null; ok = $false; why = '' }
    if (-not (Test-Path -LiteralPath $stage)) { $r.why = '받아 둔 새 버전 폴더가 없습니다'; return $r }
    try { $r.ver = ([IO.File]::ReadAllText($receipt) | ConvertFrom-Json).version } catch { $r.why = '영수증(.new.json)이 없거나 깨졌습니다'; return $r }
    $ev = Get-ExeVersion (Join-Path $stage 'herdr-app.exe')
    if ($ev -ne $r.ver) { $r.why = "받아 둔 exe 버전($ev)이 영수증($($r.ver))과 다릅니다"; return $r }
    $r.ok = $true; return $r
}

# 읽기 전용: 각 프로세스의 현재 작업 폴더(cwd)가 설치 폴더 안인 것을 찾는다(PEB 읽기. 아무것도 바꾸지 않음). 반환: @{ pid; name }[]
function Get-CwdHolders([string]$Dir) {
    if (-not ('ProcCwdKeeper' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ProcCwdKeeper {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr b, byte[] buf, int n, out IntPtr r);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI p, int n, out int r);
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr Exit; public IntPtr Peb; public IntPtr Aff; public IntPtr Prio; public IntPtr Pid; public IntPtr Ppid; }
  public static string Get(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      PBI p = new PBI(); int r;
      if (NtQueryInformationProcess(h, 0, ref p, Marshal.SizeOf(p), out r) != 0) return null;
      byte[] b8 = new byte[8]; IntPtr n;
      if (!ReadProcessMemory(h, p.Peb + 0x20, b8, 8, out n)) return null;
      IntPtr pp = (IntPtr)BitConverter.ToInt64(b8, 0);
      byte[] us = new byte[16];
      if (!ReadProcessMemory(h, pp + 0x38, us, 16, out n)) return null;
      int len = BitConverter.ToUInt16(us, 0); IntPtr buf = (IntPtr)BitConverter.ToInt64(us, 8);
      if (len <= 0 || len > 4096) return null;
      byte[] sb = new byte[len];
      if (!ReadProcessMemory(h, buf, sb, len, out n)) return null;
      return Encoding.Unicode.GetString(sb);
    } finally { CloseHandle(h); }
  }
}
'@
    }
    $key = ($Dir.TrimEnd('\') + '\').ToLowerInvariant()
    $out = @()
    foreach ($p in Get-Process) {
        $c = [ProcCwdKeeper]::Get($p.Id)
        if ($c -and (($c.TrimEnd('\') + '\').ToLowerInvariant().StartsWith($key))) { $out += [pscustomobject]@{ pid = $p.Id; name = $p.ProcessName } }
    }
    return $out
}

# 설치 폴더의 herdr-app.exe(이름이 .old-* 로 바뀐 실행 중 파일 포함)로 떠 있는 프로세스. Process.Path 는 간헐적으로 비어 돌아와(실측) WMI 로 읽는다.
function Get-AppProcs([string]$Dir) {
    $pat = (Join-Path $Dir 'herdr-app.exe') + '*'
    for ($try = 0; $try -lt 2; $try++) {            # 비어 있으면 한 번 더 본다(WMI 가 드물게 일시적으로 빈 결과를 줄 수 있다)
        $out = @()
        foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='herdr-app.exe'" -ErrorAction SilentlyContinue)) {
            if ("$($p.ExecutablePath)" -like $pat) { $out += [pscustomobject]@{ Id = [int]$p.ProcessId; StartTime = $p.CreationDate; Path = "$($p.ExecutablePath)" } }
        }
        if ($out.Count -gt 0) { break }
        Start-Sleep -Milliseconds 300
    }
    return $out
}

# 지금 상태를 한 덩어리로(빠름: cwd 검사는 하지 않는다). kind: none(할 것 없음) | ready(새 버전 대기) | restart(파일은 새것, 창은 옛것)
function Get-AppUpdateState {
    $dir = Get-AppInstallDir
    $installed = Get-ExeVersion (Join-Path $dir 'herdr-app.exe')
    $st = Get-AppStaged $dir
    $procs = @(Get-AppProcs $dir)
    $applied = $null
    try { $applied = [IO.File]::ReadAllText($AppUpdStateFile) | ConvertFrom-Json } catch {}
    $needsRestart = $false
    if ($procs.Count -gt 0 -and $applied -and $applied.appliedAt) {
        try { $needsRestart = @($procs | Where-Object { $_.StartTime -lt [datetime]$applied.appliedAt }).Count -gt 0 } catch {}
    }
    $kind = 'none'
    if ($st.ok -and $installed -and (Test-NewerVersion $st.ver $installed)) { $kind = 'ready' }
    elseif ($needsRestart) { $kind = 'restart' }
    return [pscustomobject]@{ kind = $kind; installed = $installed; staged = $(if ($st.ok) { $st.ver } else { $null }); stagedWhy = $st.why; running = ($procs.Count -gt 0); needsRestart = $needsRestart; dir = $dir }
}

# 화면이 읽는 상태 파일(작게). 내용이 같으면 다시 쓰지 않는다.
function Save-AppUpdateState($S) {
    try {
        $prev = $null; try { $prev = [IO.File]::ReadAllText($AppUpdStateFile) | ConvertFrom-Json } catch {}
        $o = [ordered]@{ kind = $S.kind; installed = $S.installed; staged = $S.staged; running = $S.running; checkedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss') }
        if ($prev -and $prev.appliedAt) { $o.appliedAt = $prev.appliedAt; $o.from = $prev.from; $o.to = $prev.to; $o.backup = $prev.backup }
        [IO.File]::WriteAllText($AppUpdStateFile, ($o | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    } catch {}
}

# 표식 내용: "<시각>|<pid>|run" (재시작 진행 중) 또는 "<시각>|<pid>|done" (새 창이 뜬 직후: 키퍼 루프가 그 재시작을 사고로 오인하지 않도록 90초만 더 남긴다)
# 내용 끝에 부팅 ID 를 붙여, 재부팅 전에 남은 표식이 새 부팅의 복구 라운드를 막지 못하게 한다. 표식을 쓴 프로세스가 죽었는지는 Get-AppUpdateMarkerPid 로 본다.
function Get-AppUpdateMarker {
    try {
        if (-not (Test-Path -LiteralPath $AppUpdMarker)) { return $null }
        $p = [IO.File]::ReadAllText($AppUpdMarker).Trim() -split '\|'
        if ($p.Count -ge 4 -and $p[3] -ne (Get-BootId)) { Remove-TempFile $AppUpdMarker; return $null }      # 다른 부팅의 표식
        $state = $(if ($p.Count -ge 3 -and $p[2] -eq 'done') { 'done' } else { 'run' })
        $limit = $(if ($state -eq 'done') { 1.5 } else { 10 })
        if (((Get-Date) - [datetime]$p[0]).TotalMinutes -le $limit) { return $state }
        Remove-TempFile $AppUpdMarker; return $null
    } catch { return $null }
}
function Get-AppUpdateMarkerPid { try { $p = [IO.File]::ReadAllText($AppUpdMarker).Trim() -split '\|'; return [int]$p[1] } catch { return 0 } }
function Test-AppUpdateInProgress { return [bool](Get-AppUpdateMarker) }              # 앱이 새로 떠도 사고가 아님(run/done 모두)
function Test-AppUpdateBusy { return ((Get-AppUpdateMarker) -eq 'run') }               # 창을 끄고 켜는 중(이 동안은 창 배치를 읽을 수 없으니 기록을 건너뛴다)
function Set-AppUpdateMarker([string]$State) { try { [IO.File]::WriteAllText($AppUpdMarker, "$((Get-Date).ToString('yyyy-MM-ddTHH:mm:ss'))|$PID|$State|$(Get-BootId)") } catch {} }

# 지난 업데이트가 남긴 .old-* 파일(옛 창이 끝났으면 지울 수 있다)과 오래된 백업(최근 2개만)을 정리한다. 실패해도 조용히 넘어간다.
function Clear-AppUpdateLeftovers {
    $dir = Get-AppInstallDir
    $mx = Enter-AppUpdateMutex
    if (-not $mx) { return }                                  # 다른 업데이트가 파일을 바꾸는 중이면 그 원복용 .old-* 를 지우지 않는다
    try {
        foreach ($f in @(Get-ChildItem -LiteralPath $dir -Filter '*.old-*' -Recurse -File -ErrorAction SilentlyContinue)) { try { [IO.File]::Delete($f.FullName) } catch {} }
        $parent = Split-Path -Parent $dir; $leaf = Split-Path -Leaf $dir
        Get-ChildItem -LiteralPath $parent -Directory -Filter "$leaf.backup-*" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip 2 | ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop } catch {} }
    } catch {} finally { try { $mx.ReleaseMutex() } catch {} }
}

# 업데이트 뮤텍스 획득(못 얻으면 $null). 업데이트 프로세스가 뮤텍스를 쥔 채 죽으면(AbandonedMutexException) 소유권을 넘겨받은 것으로 본다.
function Enter-AppUpdateMutex {
    $m = New-Object Threading.Mutex($false, 'Local\HerdrAppUpdate')
    try { if ($m.WaitOne(0)) { return $m } else { return $null } }
    catch [Threading.AbandonedMutexException] { return $m }
}

# 되돌리지 못한 파일 수를 돌려준다(0 = 전부 원복됨)
function Undo-AppFileSwap($Done) {
    $fails = 0
    for ($i = $Done.Count - 1; $i -ge 0; $i--) {
        $r = $Done[$i]
        try { if (Test-Path -LiteralPath $r.target) { [IO.File]::Delete($r.target) } } catch { $fails++; Write-Log "원복 중 새 파일 삭제 실패: $($r.target): $($_.Exception.Message)" }
        try { if ($r.old -and (Test-Path -LiteralPath $r.old)) { [IO.File]::Move($r.old, $r.target) } } catch { $fails++; Write-Log "원복 실패: $($r.old) -> $($r.target): $($_.Exception.Message)" }
    }
    return $fails
}

# 파일 교체(폴더 이름은 그대로). 반환: @{ ok; msg; from; to; backup; oldExe }
function Invoke-AppFileSwap([string]$Dir, $St, [string]$InstalledVer) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$Dir.backup-$InstalledVer-$stamp"
    try { Copy-Item -LiteralPath $Dir -Destination $backup -Recurse -Force -ErrorAction Stop }
    catch {
        try { Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue } catch {}      # 불완전한 백업이 정상 백업을 밀어내지 않게 지운다
        return @{ ok = $false; msg = "백업을 만들지 못해 중단했습니다(아무것도 바꾸지 않음): $($_.Exception.Message)" }
    }
    $done = New-Object System.Collections.ArrayList
    $stageRoot = (Resolve-Path -LiteralPath $St.dir).Path.TrimEnd('\')
    try {
        foreach ($f in @(Get-ChildItem -LiteralPath $stageRoot -Recurse -File)) {
            $rel = $f.FullName.Substring($stageRoot.Length).TrimStart('\')
            $t = Join-Path $Dir $rel
            $tdir = Split-Path -Parent $t
            if (-not (Test-Path -LiteralPath $tdir)) { New-Item -ItemType Directory -Path $tdir -Force -ErrorAction Stop | Out-Null }
            $old = $null
            if (Test-Path -LiteralPath $t) { $old = "$t.old-$stamp"; [IO.File]::Move($t, $old) }       # 실행 중인 exe 도 이름은 바꿀 수 있다
            [void]$done.Add(@{ target = $t; old = $old })
            [IO.File]::Copy($f.FullName, $t, $false)
        }
        foreach ($r in $done) {                                                                          # 검증: 새 파일 전부의 해시가 받아 둔 것과 같은가
            $rel = $r.target.Substring($Dir.TrimEnd('\').Length).TrimStart('\')
            $a = (Get-FileHash -LiteralPath $r.target -Algorithm SHA256).Hash
            $b = (Get-FileHash -LiteralPath (Join-Path $stageRoot $rel) -Algorithm SHA256).Hash
            if ($a -ne $b) { throw "해시 불일치: $rel" }
        }
        $v = Get-ExeVersion (Join-Path $Dir 'herdr-app.exe')
        if ($v -ne $St.ver) { throw "교체 뒤 exe 버전이 $($St.ver) 이어야 하는데 $v 입니다" }
    } catch {
        $undoFails = Undo-AppFileSwap $done
        $back = Get-ExeVersion (Join-Path $Dir 'herdr-app.exe')
        if ($undoFails -gt 0) { return @{ ok = $false; msg = "파일 교체 실패 + 원복도 $undoFails 건 실패했습니다. 전체 백업에서 복원하세요: $backup (현재 exe 버전 $back): $($_.Exception.Message)"; backup = $backup } }
        return @{ ok = $false; msg = "파일 교체 실패 -> 전부 원복했습니다(현재 exe 버전 $back): $($_.Exception.Message)"; backup = $backup }
    }
    $oldExe = @($done | Where-Object { $_.old -and $_.target -like '*\herdr-app.exe' } | ForEach-Object { $_.old })[0]
    return @{ ok = $true; msg = '파일 교체 완료'; from = $InstalledVer; to = $St.ver; backup = $backup; oldExe = $oldExe; done = $done }
}

# 새 앱을 올린다. 기본은 탐색기 경유(사용자가 평소 켜는 방식: 깨끗한 환경변수, 키퍼와 독립). 시험에서만 직접 실행(KEEPER_APP_LAUNCH=direct).
function Start-AppWindow([string]$Exe) {
    if ($env:KEEPER_APP_LAUNCH -eq 'direct') { Start-Process -FilePath $Exe -WorkingDirectory $env:USERPROFILE | Out-Null; return }
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $Exe + '"') | Out-Null
}

function Get-LiveCount { $ls = Invoke-HcJson @('ls'); if ($ls) { return @($ls.terminals | Where-Object { $_.state -eq 'live' }).Count } else { return -1 } }

# -Mode Update 의 본체. $PlanOnly: 진단만. $Restart: 파일 교체 뒤 창을 껐다 켠다(터미널은 코어가 유지).
function Invoke-AppUpdate([bool]$PlanOnly, [bool]$Restart) {
    $mutex = Enter-AppUpdateMutex
    if (-not $mutex) { Write-Host '다른 업데이트가 이미 진행 중입니다.'; return 2 }
    try {
        $dir = Get-AppInstallDir
        $s = Get-AppUpdateState
        Save-AppUpdateState $s
        Write-Host "설치된 앱 파일: $($s.installed) / 받아 둔 새 버전: $(if ($s.staged) { $s.staged } else { "없음 ($($s.stagedWhy))" }) / 창 실행 중: $($s.running) / 파일은 새것인데 창이 옛것: $($s.needsRestart)"
        if ($s.kind -eq 'none') { Write-Host '할 일이 없습니다(이미 최신이거나 받아 둔 새 버전이 없습니다).'; return 0 }
        if ($PlanOnly -and $s.kind -eq 'ready') {     # 느린 진단(전체 프로세스 조사)은 미리보기에서만: 런처가 앱을 켜는 길에는 지연을 주지 않는다
            $holders = @(Get-CwdHolders $dir)
            Write-Host "앱 자신의 교체(폴더 이름 바꾸기)가 막히는 이유: 설치 폴더를 작업 폴더로 잡은 프로세스 $($holders.Count) 개 (앱/코어/터미널 호스트). 그래서 폴더가 아니라 파일을 교체합니다."
        }
        if ($PlanOnly) {
            if ($s.kind -eq 'ready') { Write-Host "[미리보기] 실제로는: 백업 -> 파일 교체($($s.installed) -> $($s.staged)) -> 해시/버전 검증$(if ($Restart -and $s.running) { ' -> 창 재시작(터미널 유지)' }). 지금은 아무것도 바꾸지 않았습니다." }
            else { Write-Host '[미리보기] 파일은 이미 새것입니다. 창만 껐다 켜면 됩니다.' }
            return 0
        }
        $before = $(if ($Restart -and $s.running) { Get-LiveCount } else { -1 })      # hc 조회는 창을 껐다 켤 때만(런처 경로에서는 hc 가 느려도 앱을 켜는 데 영향이 없게)
        if ($s.running -and $Restart -and $before -lt 0) { Write-Host '코어(hc)가 응답하지 않아 창을 건드리지 않습니다. 코어가 정상일 때 다시 하세요.'; return 3 }
        $oldPids = @(Get-AppProcs $dir | ForEach-Object { $_.Id })
        $oldExe = $null
        if ($s.kind -eq 'ready') {
            $st = Get-AppStaged $dir
            $sw = Invoke-AppFileSwap $dir $st $s.installed
            if (-not $sw.ok) { Write-Log "앱 업데이트 실패: $($sw.msg)"; Write-Host $sw.msg; return 4 }
            $oldExe = $sw.oldExe
            try { [IO.File]::WriteAllText($AppUpdStateFile, ([ordered]@{ kind = 'restart'; installed = $sw.to; staged = $null; running = $s.running; checkedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss'); appliedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss'); from = $sw.from; to = $sw.to; backup = $sw.backup } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false))) } catch {}
            try { Remove-Item -LiteralPath $st.dir -Recurse -Force -ErrorAction Stop; [IO.File]::Delete($st.receipt) } catch { Write-Log "받아 둔 폴더 정리 실패(무해): $($_.Exception.Message)" }   # 남아 있으면 앱이 "다시 시작" 안내를 계속 띄운다
            Write-Log "앱 파일 교체 완료: $($sw.from) -> $($sw.to) (백업 $($sw.backup)). 창은 $(if ($oldPids.Count) { '아직 옛 버전이 실행 중' } else { '꺼져 있음' })"
            Write-Host "앱 파일을 $($sw.from) -> $($sw.to) 로 교체했습니다. 백업: $($sw.backup)"
        }
        if ($oldPids.Count -eq 0) { Write-Host '앱 창이 꺼져 있어 재시작은 필요 없습니다. 다음에 켜면 새 버전입니다.'; Clear-AppUpdateLeftovers; return 0 }
        if (-not $Restart) { Write-Host '창은 옛 버전 그대로입니다. 새 버전으로 바꾸려면 창을 껐다 켜세요(터미널은 유지됩니다). 그때까지 앱 명령(herdr-app ...)은 옛 창과 새 명령줄이 섞입니다.'; return 0 }
        # ---- 창 재시작 ----
        Set-AppUpdateMarker 'run'
        $cli =$(if ($oldExe -and (Test-Path -LiteralPath $oldExe)) { $oldExe } else { Join-Path $dir 'herdr-app.exe' })      # 옛 창에는 옛 명령줄로 말한다(버전 섞임 방지)
        Write-Log "앱 창을 종료합니다(터미널은 코어가 유지). 종료 명령: $(Split-Path -Leaf $cli) do app.quit / 업데이트 전 살아 있는 터미널 $before 개"
        $q = Invoke-Exe $cli @('do', 'app.quit') 30
        $deadline = (Get-Date).AddSeconds(60)
        while ((Get-Date) -lt $deadline -and (@($oldPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }).Count -gt 0)) { Start-Sleep -Milliseconds 500 }
        if (@($oldPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }).Count -gt 0) {
            Remove-TempFile $AppUpdMarker
            Write-Log "옛 창이 60초 안에 종료되지 않았습니다(종료 명령 결과: $($q.code) $($q.out)). 강제로 끄지 않고 그대로 둡니다. 파일은 이미 새 버전입니다."
            Write-Host '옛 창이 60초 안에 닫히지 않았습니다. 강제로 끄지 않았습니다. 창을 직접 닫았다가 다시 열면 새 버전으로 뜹니다.'
            return 5
        }
        Start-AppWindow (Join-Path $dir 'herdr-app.exe')
        $up = $null; $deadline = (Get-Date).AddSeconds(60)
        while ((Get-Date) -lt $deadline -and -not $up) { Start-Sleep -Seconds 1; $up = @(Get-AppProcs $dir | Where-Object { $oldPids -notcontains $_.Id })[0] }
        if (-not $up) { Remove-TempFile $AppUpdMarker; Write-Log '새 앱 창이 60초 안에 뜨지 않았습니다. 터미널은 코어에 살아 있습니다. Herdr 를 직접 켜 주세요.'; Write-Host '새 앱 창이 뜨지 않았습니다. 터미널은 살아 있습니다. Herdr 를 직접 켜 주세요.'; return 6 }
        Set-AppUpdateMarker 'done'      # 새 창이 떴다: 키퍼 루프가 이 재시작을 새 사건으로 세지 않도록 잠깐(90초) 더 남긴다
        Start-Sleep -Seconds 10
        $stat = Invoke-Exe (Join-Path $dir 'herdr-app.exe') @('status') 30
        $after = Get-LiveCount
        Save-AppUpdateState (Get-AppUpdateState)
        $verNow = Get-ExeVersion (Join-Path $dir 'herdr-app.exe')
        Write-Log "앱 재시작 완료: 버전 $verNow / 창 pid $($up.Id) / 살아 있는 터미널 $before -> $after / status: $(if ($stat.ok) { '응답함' } else { '응답 없음' })"
        Write-Host "새 앱 창이 떴습니다(버전 $verNow). 살아 있는 터미널 $before -> $after 개."
        if ($after -ge 0 -and $before -ge 0 -and $after -lt $before) { Write-Host "주의: 터미널 수가 줄었습니다($before -> $after). session-keeper.log 를 확인하세요." }
        return 0
    } finally { try { $mutex.ReleaseMutex() } catch {} }
}

# 키퍼 루프가 5분마다 부르는 점검. 기본은 "알리기만"(상태 파일 + 로그 + 알림 1회). 자동 허용 파일이 있고 모든 에이전트가 한가한 상태가 3번 연속이면 스스로 적용한다.
$script:AppUpdAnnounced = ''
$script:AppUpdQuiet = 0
function Test-AllQuiet {
    $ls = Invoke-HcJson @('ls')
    if (-not $ls) { return $false }
    foreach ($t in @($ls.terminals | Where-Object { $_.state -eq 'live' })) { if ("$($t.status)" -match '^(working|blocked)$') { return $false } }
    return $true
}
function Invoke-AppUpdateTick {
    try {
        $s = Get-AppUpdateState
        Save-AppUpdateState $s
        Clear-AppUpdateLeftovers
        if ($s.kind -eq 'none') { $script:AppUpdQuiet = 0; return }
        $tag = "$($s.kind):$($s.staged):$($s.installed)"
        if ($script:AppUpdAnnounced -ne $tag) {
            $script:AppUpdAnnounced = $tag
            if ($s.kind -eq 'ready') {
                Write-Log "앱 업데이트 대기: 설치 $($s.installed) -> 새 버전 $($s.staged) (앱이 열려 있으면 앱 자신은 못 깝니다). 적용: session-keeper.ps1 -Mode Update (창만 껐다 켬, 터미널 유지) 또는 Herdr 복구 창의 [앱 업데이트] 버튼"
                try { Show-Toast 'Herdr 앱 업데이트 대기' "$($s.installed) -> $($s.staged) 를 세션키퍼가 적용할 수 있습니다. 복구 창의 [앱 업데이트] 버튼을 누르세요." } catch {}
            } else { Write-Log "앱 파일은 새 버전($($s.installed))이지만 열린 창은 옛 버전입니다. 창을 껐다 켜면 반영됩니다(복구 창의 [앱 업데이트] 버튼)." }
        }
        if ((-not (Test-AppAutoUpdate)) -or (-not (Test-Path -LiteralPath $AppUpdIdleFile))) { return }
        if (Test-AllQuiet) { $script:AppUpdQuiet++ } else { $script:AppUpdQuiet = 0 }
        if ($script:AppUpdQuiet -ge 3) {
            $script:AppUpdQuiet = 0
            Write-Log '자동 업데이트가 켜져 있고(한가할 때 적용 허용) 모든 창이 한가해 앱 업데이트를 적용합니다.'
            $null = Invoke-AppUpdate $false $true
        }
    } catch { Write-Log "앱 업데이트 점검 오류(무시): $($_.Exception.Message)" }
}

# Herdr 가 "방금 켜진" 것을 키퍼가 감지했을 때(실행 루프): 새 버전이 받아져 있으면 곧바로 적용한다.
# 방금 켜진 창만 대상(켠 지 3분 이내). 오래 쓰던 창은 자동으로 껐다 켜지 않고 알리기만 한다. 반환: 적용해서 창이 다시 떴으면 $true
function Invoke-AppUpdateOnStart($App) {
    try {
        if (-not (Test-AppAutoUpdate)) { return $false }
        $s = Get-AppUpdateState
        Save-AppUpdateState $s
        if ($s.kind -ne 'ready') { return $false }
        if ($App -and ((Get-Date) - $App.StartTime).TotalSeconds -gt 180) { Write-Log "새 버전 $($s.staged) 이 대기 중이지만 앱이 켜진 지 3분이 넘어 자동으로 껐다 켜지 않습니다(알림만)."; return $false }
        Write-Log "Herdr 시작 감지: 설치 $($s.installed) < 새 버전 $($s.staged) -> 자동 업데이트를 적용합니다."
        return ((Invoke-AppUpdate $false $true) -eq 0)
    } catch { Write-Log "시작 시 자동 업데이트 오류(무시): $($_.Exception.Message)"; return $false }
}

# ---------------------------------------------------------------- 런처: 앱이 "켜지기 전에" 업데이트를 먼저 적용하고 앱을 올린다
# 바탕화면/시작 메뉴 바로가기가 herdr-launch.vbs 를 거치게 한다. 앱이 아직 없으니 창 재시작도, 터미널이 설치 폴더를 붙잡는 일도 없다.
# 어떤 이유로든 실패해도 앱은 반드시 켠다(herdr-launch.vbs 가 마지막 안전망). 작업 폴더는 항상 사용자 폴더로 올려 설치 폴더를 붙잡지 않게 한다.
function Invoke-HerdrLaunch {
    $dir = Get-AppInstallDir; $exe = Join-Path $dir 'herdr-app.exe'
    try {
        if ((Test-AppAutoUpdate) -and (@(Get-AppProcs $dir).Count -eq 0)) {
            $s = Get-AppUpdateState
            if ($s.kind -eq 'ready') { Write-Log "런처: 앱을 켜기 전에 새 버전 $($s.staged) 를 적용합니다(설치 $($s.installed))."; $null = Invoke-AppUpdate $false $false }
        }
    } catch { Write-Log "런처 오류(무시하고 앱을 켭니다): $($_.Exception.Message)" }
    if ($env:KEEPER_APP_NOLAUNCH) { return }
    Remove-Item Env:KEEPER_NO_MAIN -ErrorAction SilentlyContinue      # 앱·코어·터미널이 이 값을 물려받으면 복구 창 버튼이 띄우는 키퍼가 아무것도 안 하고 끝난다
    Start-Process -FilePath $exe -WorkingDirectory $env:USERPROFILE | Out-Null
}

$LauncherManifest = Join-Path $Dir 'session-keeper.launcher.json'
$LauncherBackupDir = Join-Path $Dir 'shortcut-backup'
$LauncherVbs = Join-Path $Dir 'herdr-launch.vbs'

function Get-HerdrShortcutRoots {
    if ($env:KEEPER_SHORTCUT_ROOTS) { return @($env:KEEPER_SHORTCUT_ROOTS -split ';' | Where-Object { $_ }) }
    @("$env:APPDATA\Microsoft\Windows\Start Menu", "$env:ProgramData\Microsoft\Windows\Start Menu", [Environment]::GetFolderPath('Desktop'), "$env:PUBLIC\Desktop", "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned")
}
# Herdr 앱을 가리키는 바로가기. kind: retarget(대상을 런처로 바꿈) | startin(시작 위치만 고침: 작업표시줄 고정 아이콘은 대상을 바꾸면 창이 아이콘 두 개로 갈라진다)
function Find-HerdrShortcuts {
    $exe = Join-Path (Get-AppInstallDir) 'herdr-app.exe'
    $sh = New-Object -ComObject WScript.Shell
    $out = @()
    foreach ($r in (Get-HerdrShortcutRoots)) {
        if (-not (Test-Path -LiteralPath $r)) { continue }
        foreach ($f in @(Get-ChildItem -LiteralPath $r -Recurse -Filter *.lnk -ErrorAction SilentlyContinue)) {
            try {
                $l = $sh.CreateShortcut($f.FullName)
                $isOurs = ($l.TargetPath -like '*wscript.exe' -and $l.Arguments -like '*herdr-launch.vbs*')
                if ($l.TargetPath -ieq $exe -or $isOurs) {
                    $kind = $(if ($f.FullName -match '\\User Pinned\\') { 'startin' } else { 'retarget' })
                    $out += [pscustomobject]@{ path = $f.FullName; kind = $kind; ours = $isOurs; startIn = $l.WorkingDirectory }
                }
            } catch {}
        }
    }
    return $out
}

function Install-HerdrLauncher {
    $exe = Join-Path (Get-AppInstallDir) 'herdr-app.exe'
    if (-not (Test-Path -LiteralPath $LauncherVbs)) { Write-Host "런처 파일이 없습니다: $LauncherVbs"; return 1 }
    if (-not (Test-Path -LiteralPath $LauncherBackupDir)) { New-Item -ItemType Directory -Path $LauncherBackupDir -Force | Out-Null }
    # 바로가기는 프로젝트 폴더(D:)가 아니라 이 로컬 사본을 가리킨다: 프로젝트 폴더가 옮겨지거나 드라이브가 없어도 사본이 앱을 직접 켠다(조용히 아무 반응 없는 일을 막음)
    $localDir = $(if ($env:KEEPER_LAUNCHER_DIR) { $env:KEEPER_LAUNCHER_DIR } else { Join-Path $env:LOCALAPPDATA 'HerdrSessionKeeper' })
    $launchVbs = $LauncherVbs
    try {
        if (-not (Test-Path -LiteralPath $localDir)) { New-Item -ItemType Directory -Path $localDir -Force | Out-Null }
        $abs = Join-Path $Dir 'herdr-launch.ps1'
        $body = [IO.File]::ReadAllText($LauncherVbs, [Text.Encoding]::GetEncoding(28591))
        if ($abs -match '^[\x20-\x7e]+$' -and $body.Contains('ps1 = here & "\herdr-launch.ps1"')) {          # VBS 는 ANSI 라 ASCII 경로일 때만 사본을 만든다
            $body = $body.Replace('ps1 = here & "\herdr-launch.ps1"', 'ps1 = "' + $abs + '"')
            $launchVbs = Join-Path $localDir 'herdr-launch.vbs'
            [IO.File]::WriteAllText($launchVbs, $body, [Text.Encoding]::GetEncoding(28591))
        }
    } catch { $launchVbs = $LauncherVbs }
    $sh = New-Object -ComObject WScript.Shell
    $items = @(); $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'; $seq = 0
    foreach ($s in @(Find-HerdrShortcuts)) {
        $seq++
        if ($s.ours -and $s.kind -eq 'retarget') { Write-Host "이미 런처로 연결됨: $($s.path)"; continue }
        if ($s.kind -eq 'startin' -and "$($s.startIn)" -ieq "$env:USERPROFILE") { Write-Host "이미 시작 위치가 사용자 폴더임: $($s.path)"; continue }     # 이미 고친 것을 "원본"으로 다시 백업하지 않는다
        $bak = Join-Path $LauncherBackupDir ("{0}-{1}-{2}.lnk" -f ([IO.Path]::GetFileNameWithoutExtension($s.path) -replace '[^\w\-]', '_'), $stamp, $seq)      # 이름이 같은 바로가기끼리 백업이 덮어써지지 않게 일련번호
        try {
            Copy-Item -LiteralPath $s.path -Destination $bak -Force -ErrorAction Stop
            $l = $sh.CreateShortcut($s.path)
            if ($s.kind -eq 'retarget') { $l.TargetPath = (Join-Path $env:SystemRoot 'System32\wscript.exe'); $l.Arguments = '//B "' + $launchVbs + '"'; $l.IconLocation = "$exe,0" }
            $l.WorkingDirectory = $env:USERPROFILE      # 대상을 바꾸면 시작 위치가 초기화되므로 반드시 마지막에 설정한다
            $l.Save()
            $chk = $sh.CreateShortcut($s.path)
            if ($chk.WorkingDirectory -ne $env:USERPROFILE) { throw '저장 뒤 시작 위치가 바뀌지 않았습니다' }
            $items += [pscustomobject]@{ path = $s.path; backup = $bak; kind = $s.kind }
            Write-Host ("연결함({0}): {1}" -f $(if ($s.kind -eq 'retarget') { '런처 + 시작 위치 고침' } else { '시작 위치만 고침' }), $s.path)
        } catch {
            try { Copy-Item -LiteralPath $bak -Destination $s.path -Force -ErrorAction Stop } catch {}
            Write-Host "실패하여 원래대로 되돌림: $($s.path): $($_.Exception.Message)"
        }
    }
    if ($items.Count -gt 0) {
        $prev = @(); try { $prev = @(([IO.File]::ReadAllText($LauncherManifest) | ConvertFrom-Json).items) } catch {}
        $keep = @($prev | Where-Object { $_ -and $_.path }); $have = @{}; foreach ($k in $keep) { $have["$($k.path)".ToLowerInvariant()] = $true }
        $merged = @($keep + @($items | Where-Object { -not $have.ContainsKey("$($_.path)".ToLowerInvariant()) }))       # 같은 바로가기는 "최초 원본" 백업만 남긴다
        try { [IO.File]::WriteAllText($LauncherManifest, ([ordered]@{ at = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss'); items = $merged } | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false))) } catch {}
        Write-Log "런처 설치: 바로가기 $($items.Count)개 연결(백업 $LauncherBackupDir)"
    }
    return 0
}

function Uninstall-HerdrLauncher {
    $m = $null; try { $m = [IO.File]::ReadAllText($LauncherManifest) | ConvertFrom-Json } catch {}
    if (-not $m -or -not $m.items) { Write-Host '되돌릴 런처 연결 기록이 없습니다.'; return 0 }
    $n = 0
    foreach ($it in @($m.items)) {
        try { if (Test-Path -LiteralPath $it.backup) { Copy-Item -LiteralPath $it.backup -Destination $it.path -Force -ErrorAction Stop; $n++; Write-Host "원래대로 복원: $($it.path)" } else { Write-Host "백업이 없어 건너뜀: $($it.path)" } }
        catch { Write-Host "복원 실패: $($it.path): $($_.Exception.Message)" }
    }
    Remove-TempFile $LauncherManifest
    Write-Log "런처 제거: 바로가기 $n 개 복원"
    return 0
}

function Show-HerdrLauncher {
    $l = @(Find-HerdrShortcuts)
    if ($l.Count -eq 0) { Write-Host 'Herdr 바로가기를 찾지 못했습니다.'; return }
    foreach ($s in $l) { Write-Host ("{0} | {1} | 시작 위치: {2} | {3}" -f $(if ($s.ours) { '런처 연결됨' } else { '직접 실행' }), $s.kind, $s.startIn, $s.path) }
}
