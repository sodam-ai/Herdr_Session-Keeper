# session-keeper.ps1 - 재부팅/갑작스러운 종료 뒤 Herdr 의 Claude 세션을 자동으로 이어 붙인다.
#
# 공식 동작(herdr-app AGENTS.md): 재부팅으로 사라진 창은 "같은 주소의 빈 셸"로 되살아나고 원래 명령(claude)은 다시 실행되지 않는다.
# 이미 끝나 버린 창(killed)은 되살아나지 않는다. 그래서 이 스크립트가 아래를 맡는다.
#   1) 살아 있는 동안 "창 주소 -> Claude 세션ID/공간/탭" 을 1분마다 session-map.json 에 기록
#   2) 빈 셸로 되살아난 창  -> 그 셸에 "claude --resume" 입력 (사용자의 분할/이름/배치 자리를 그대로 살림)
#   3) 끝나 버린 창         -> 같은 이름의 공간에 새 탭을 만들어 "claude --resume" 실행 (tab.new / space.new, 공식 명령)
#   4) Herdr 앱이 켜질 때마다 10분 동안 30초 간격으로 반복 시도 (PC 부팅만으로는 시작하지 않음)
#
# 모드:
#   Snapshot : 지금 상태를 1회 기록
#   Recover  : 복구 1회 (-Plan 이면 입력/생성 없이 판단만 출력)
#   Run      : Herdr 앱이 켜져 있는 동안만 상주(감시 작업이 앱을 확인해 시작). 코어 대기 -> 복구 창 열기 -> 이후 60초마다 기록 -> 앱이 2분 넘게 꺼지면 종료
#
# 안전 규칙(하나라도 틀리면 그 창은 건너뜀): 같은 세션이 이미 실행 중이 아님 / 대화 파일(.jsonl) 존재 / 시도 3회 미만 /
#   (빈 셸) 같은 탭 id 또는 이름 + 앞 프로그램이 powershell + Claude 없음 + 빈 PS 프롬프트 /
#   (새 탭) 코어 시작 120초 뒤부터만(유예 시간 안에 되살아날 창과 겹치지 않게)
param(
    [ValidateSet('Snapshot', 'Recover', 'Run', 'Forget', 'Update')][string]$Mode = 'Snapshot',
    [switch]$Plan,
    [switch]$NoRestart,        # -Mode Update 용: 앱 파일만 새 버전으로 바꾸고 창은 그대로 둔다(기본은 창도 껐다 켠다. 터미널은 코어가 유지)
    [ValidateSet('', 'On', 'Off', 'Status')][string]$Auto = '',          # -Mode Update 용: 앱 자동 업데이트 켜기/끄기/상태(기본 켜짐)
    [ValidateSet('', 'Install', 'Uninstall', 'Status')][string]$Launcher = '',   # -Mode Update 용: 바로가기를 런처(앱을 켜기 전에 업데이트)에 연결/해제/상태
    [string]$Only = '',
    [switch]$Stale,            # -Mode Forget 용: "닫히기 직전"이 아닌 옛 복구 대기 항목을 한꺼번에 목록에서 뺀다(지우기 전 백업을 남김)
    [string]$Sid = '',         # -Mode Forget 용: 목록에서 뺄 세션ID(앞 6자 이상)
    [int]$Batch = 6,           # 한 번에 입력하는 창 수 (2026-11-04: 3 -> 6. 실제 재부팅에서 CPU 15~45%(32코어)·메모리 22GB 여유라 느릴 이유가 없었음)
    [int]$DelaySec = 4,           # 묶음 사이 대기(초) (25 -> 4)
    [int]$LoopSec = 60,
    [int]$MassCount = 6,       # 이 개수 이상이 MassSec 안에 한꺼번에 죽으면 "사고"로 보고 기록을 보존
    [int]$MassSec = 30,
    [int]$RecentMin = 10,      # 자동 복구 대상: 대기 기록 중 "가장 늦게 확인된 시각"에서 이 분(分) 안에 확인된 창만(=닫히기 직전에 열려 있던 창). 0 이면 끄고 전부 복구
    [int]$WindowMin = 10,      # 복구 창 길이
    [int]$RoundSec = 30,       # 복구 반복 간격
    [int]$MinWaitSec = 120,    # 새 탭 생성은 이 시간이 지난 뒤부터
    [int]$MaxAttempts = 3,
    [int]$AppGoneExitSec = 120, # Herdr 앱이 이 시간(초) 넘게 꺼져 있으면 Run 을 끝낸다(앱을 켤 때만 동작하게)
    [string]$Template = 'claude --resume {0}',   # 시험용으로만 바꿈 (예: 'Write-Output RESTORED-{0}')
    [string]$CodexTemplate = 'codex resume {0}'  # Codex 대화 복구 명령(시험용으로만 바꿈)
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
# hc send 가 "<hc from=..>" 로 감싸서 명령이 깨지는 것을 막는다.
$env:HC_TERMINAL_ID = $null

$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
# kit.env(설치 도구가 적는 파일): 이 PC 의 node/hc 위치가 PATH 에 없을 때 알려 준다(작업 스케줄러·Herdr 안은 PATH 가 다를 수 있다). 없으면 아무것도 하지 않는다.
# 항목: NODE_DIR/HC_DIR(PATH 앞에 붙임) / APP_EXE(Herdr 앱 exe) / APP_HOME(Herdr 설정 폴더) / CLAUDE_CFG(Claude Code 설정 폴더). 이미 환경변수가 있으면 그것이 우선.
try { $KitEnv = Join-Path $Dir 'kit.env'; if (Test-Path -LiteralPath $KitEnv) { foreach ($ln in [IO.File]::ReadAllLines($KitEnv)) { if ($ln -match '^([A-Z_]+)=(.+)$') { $kk = $Matches[1]; $kv = $Matches[2].Trim()
    if (($kk -eq 'NODE_DIR' -or $kk -eq 'HC_DIR') -and (Test-Path -LiteralPath $kv) -and (";$env:PATH;" -notlike "*;$kv;*")) { $env:PATH = $kv + ';' + $env:PATH }
    elseif ($kk -eq 'APP_EXE' -and -not $env:KEEPER_APP_EXE) { $env:KEEPER_APP_EXE = $kv }
    elseif ($kk -eq 'APP_HOME' -and -not $env:HERDR_APP_HOME) { $env:HERDR_APP_HOME = $kv }
    elseif ($kk -eq 'CLAUDE_CFG' -and -not $env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR = $kv } } } } } catch {}
$MapFile = Join-Path $Dir 'session-map.json'
$LogFile = Join-Path $Dir 'session-keeper.log'
$CutoffFile = Join-Path $Dir 'session-keeper.cutoff'   # 자동 복구 "닫히기 직전" 기준 시각(키퍼가 적고 Herdr 복구 창이 읽는다)
# Claude Code 설정 폴더: CLAUDE_CONFIG_DIR > %APPDATA%\claude-code(이 PC 의 기존 위치, 있을 때) > ~\.claude (lib/claude.mjs 와 같은 규칙)
$ClaudeCfg = $(if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } elseif ($env:APPDATA -and (Test-Path -LiteralPath (Join-Path $env:APPDATA 'claude-code'))) { Join-Path $env:APPDATA 'claude-code' } else { Join-Path $env:USERPROFILE '.claude' })
$SessDir = Join-Path $ClaudeCfg 'sessions'
$ProjDir = Join-Path $ClaudeCfg 'projects'
$AppExe = $(if ($env:KEEPER_APP_EXE) { $env:KEEPER_APP_EXE } else { Join-Path $env:LOCALAPPDATA 'Programs\herdr-app\herdr-app.exe' })
$AppProc = if ($env:KEEPER_APP_PROC) { $env:KEEPER_APP_PROC } else { 'herdr-app' }   # 감시할 앱 프로세스 이름(시험에서만 바꿈)
$ViewFile = Join-Path $(if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $env:USERPROFILE '.config\herdr-app' }) 'view.json'
$UuidRe = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$TtlDays = 365
$IsClaudeTemplate = ($Template -like 'claude*')
$IsCodexTemplate = ($CodexTemplate -like 'codex*')
$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' })
$CodexSessDir = Join-Path $CodexHome 'sessions'
$CodexSessDirDefault = $CodexSessDir
# Codex 데이터 폴더는 이 PC 에 둘(~/.codex, ~/.codex_runtime)이고 환경변수(CODEX_HOME)로 갈린다. 키퍼가 어떤 환경으로 떠도 Herdr 안의 Codex 창을 놓치지 않게 모두 찾는다.
# (시험이 $CodexSessDir 를 임시 폴더로 바꾸면 이 확장은 꺼져 실제 폴더가 섞이지 않는다)
function Get-CodexSessDirList {
    $l = @($CodexSessDir)
    if ($CodexSessDir -eq $CodexSessDirDefault) {
        foreach ($h in @((Join-Path $env:USERPROFILE '.codex_runtime'), (Join-Path $env:USERPROFILE '.codex'))) { $d = Join-Path $h 'sessions'; if ($d -ne $CodexSessDir -and (Test-Path -LiteralPath $d)) { $l += $d } }
    }
    return @($l | Select-Object -Unique)
}
. (Join-Path $Dir 'lib\appupdate.ps1')   # Herdr 앱 업데이트(앱이 열려 있어도 적용). 함수만 정의한다

function Write-Log([string]$msg) {
    $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $msg
    try {
        if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 512KB) { Move-Item $LogFile ($LogFile + '.old') -Force }
        Add-Content -Path $LogFile -Value $line -Encoding UTF8
    } catch {}
    Write-Host $line
}

function Set-Prop($o, [string]$n, $v) { $o | Add-Member -NotePropertyName $n -NotePropertyValue $v -Force }
function Get-Prop($o, [string]$n, $d) { if ($o -and $o.PSObject.Properties[$n]) { return $o.$n } else { return $d } }
function Get-BootId { (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('yyyy-MM-ddTHH:mm:ss') }
function Remove-TempFile([string]$p) { try { [IO.File]::Delete($p) } catch {} }

function Invoke-HcJson([string[]]$HcArgs) {
    try {
        $raw = (& hc @HcArgs --json 2>$null) -join "`n"
        if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
        return ($raw.TrimStart([char]0xFEFF) | ConvertFrom-Json)
    } catch { return $null }
}

# Windows 명령줄 인용 규칙: 따옴표 앞의 역슬래시는 두 배로, 따옴표는 \" 로, 끝의 역슬래시도 두 배로
# (끝이 \ 인 폴더 "C:\Program Files\" 의 \" 가 따옴표 기호로 해석돼 실패하던 문제를 막는다).
function ConvertTo-WinArg([string]$s) {
    if ($s -ne '' -and $s -notmatch '[\s"]') { return $s }
    $t = $s -replace '(\\*)"', '$1$1\"'
    $t = $t -replace '(\\+)$', '$1$1'
    return '"' + $t + '"'
}

# herdr-app 은 파이프로 바로 받으면 종료 오류가 나서, 파일로 받는다(실측).
function Invoke-App([string[]]$AppArgs) {
    $id = [guid]::NewGuid().ToString('N')
    $o = Join-Path $env:TEMP "ha-$id.out"; $e = Join-Path $env:TEMP "ha-$id.err"
    $line = ($AppArgs | ForEach-Object { ConvertTo-WinArg "$_" }) -join ' '
    $res = [pscustomobject]@{ Code = -1; Out = ''; Err = '' }
    try {
        $p = Start-Process -FilePath $AppExe -ArgumentList $line -PassThru -NoNewWindow -RedirectStandardOutput $o -RedirectStandardError $e
        $null = $p.Handle
        if (-not $p.WaitForExit(20000)) { try { $p.Kill() } catch {}; $res.Err = '시간 초과'; return $res }
        $res.Code = $p.ExitCode
        if (Test-Path $o) { $res.Out = ([IO.File]::ReadAllText($o, [Text.Encoding]::UTF8)).Trim() }
        if (Test-Path $e) { $res.Err = ([IO.File]::ReadAllText($e, [Text.Encoding]::UTF8)).Trim() }
    } catch { $res.Err = $_.Exception.Message }
    finally { Remove-TempFile $o; Remove-TempFile $e }
    return $res
}

function Get-AppLs {
    $r = Invoke-App @('ls')
    if ($r.Code -ne 0 -or -not $r.Out) { return $null }
    try { return ($r.Out | ConvertFrom-Json) } catch { return $null }
}

# 터미널 주소 -> 공간/탭 이름과 id
function Get-LayoutTable($appLs) {
    $t = @{}
    if (-not $appLs) { return $t }
    foreach ($s in @($appLs.spaces)) {
        foreach ($tb in @($s.tabs)) {
            foreach ($tm in @($tb.terminals)) {
                $t[[string]$tm.terminal] = [pscustomobject]@{ spaceId = "$($s.id)"; space = "$($s.name)"; tabId = "$($tb.id)"; tab = "$($tb.name)"; folder = "$($s.folder)" }
            }
        }
    }
    return $t
}

# 화면 선택(어느 공간/탭을 보고 있었는지) 저장과 복원 - tab.new 가 선택을 새 탭으로 옮기기 때문
function Get-Selection($appLs) {
    try {
        $v = [IO.File]::ReadAllText($ViewFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
        $sp = "$($v.active)"; $tabId = ''
        $s = @($appLs.spaces) | Where-Object { $_.id -eq $sp } | Select-Object -First 1
        if ($s) { $t = @($s.tabs) | Where-Object { $_.active } | Select-Object -First 1; if ($t) { $tabId = "$($t.id)" } }
        return @{ space = $sp; tab = $tabId }
    } catch { return $null }
}
function Restore-Selection($sel) {
    if (-not $sel -or -not $sel.space) { return }
    $null = Invoke-App @('do', 'space.select', '--id', $sel.space)
    if ($sel.tab) { $null = Invoke-App @('do', 'tab.select', '--id', $sel.tab) }
}

function Read-MapFile([string]$Path) {
    $o = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json
    $m = @{}
    if ($o) { foreach ($p in $o.PSObject.Properties) { if ($p.Value -and $p.Value.PSObject.Properties['sid']) { $m[$p.Name] = $p.Value } } }
    return $m
}

# 지도가 깨졌으면: 깨진 파일은 사본으로 남기고, 직전 정상본(.bak)이 있으면 거기서 복구한다(대기 중이던 기록을 잃지 않게).
function Read-Map {
    if (-not (Test-Path $MapFile)) { return @{} }
    try { return (Read-MapFile $MapFile) }
    catch {
        $keep = "$MapFile.corrupt-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
        try { Copy-Item $MapFile $keep -Force } catch {}
        Write-Log "지도 파일이 깨져 있어 사본을 남겼습니다($keep): $($_.Exception.Message)"
        if (Test-Path "$MapFile.bak") {
            try { $m = Read-MapFile "$MapFile.bak"; Write-Log "직전 정상본(.bak)에서 복구했습니다. 항목 $($m.Count)개"; return $m } catch {}
        }
        return @{}
    }
}

function Save-Map($m) {
    # 현재 파일이 정상일 때만 .bak 으로 보관(깨진 파일이 정상 백업을 덮어쓰지 않게)
    if (Test-Path $MapFile) { try { $null = Read-MapFile $MapFile; Copy-Item $MapFile "$MapFile.bak" -Force } catch {} }
    # 인코딩 먼저 -> 임시 파일 -> 교체 (쓰다 끊겨도 기존 파일 보존)
    $ordered = [ordered]@{}
    foreach ($k in ($m.Keys | Sort-Object)) { $ordered[$k] = $m[$k] }
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($ordered | ConvertTo-Json -Depth 5))
    $tmp = $MapFile + '.tmp'
    [IO.File]::WriteAllBytes($tmp, $bytes)
    Move-Item $tmp $MapFile -Force
}

# 살아 있는 Claude 프로세스의 세션 정보: pid -> {sessionId, cwd}
function Get-ClaudeSessions {
    $h = @{}
    if (-not (Test-Path $SessDir)) { return $h }
    foreach ($f in Get-ChildItem $SessDir -Filter '*.json' -File -ErrorAction SilentlyContinue) {
        try {
            $o = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json
            if ($o.pid -and $o.sessionId -and (Get-Process -Id ([int]$o.pid) -ErrorAction SilentlyContinue)) { $h[[int]$o.pid] = $o }
        } catch {}
    }
    return $h
}

$script:ProcInfo = @{}         # pid -> {name, cmd, created, ppid}  (Get-ChildTable 이 채움, Codex 프로세스 찾기에 사용)
function Get-ChildTable {
    $t = @{}; $info = @{}
    foreach ($p in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
        $pp = [int]$p.ParentProcessId
        if (-not $t.ContainsKey($pp)) { $t[$pp] = New-Object System.Collections.ArrayList }
        [void]$t[$pp].Add([int]$p.ProcessId)
        $info[[int]$p.ProcessId] = @{ name = "$($p.Name)"; cmd = "$($p.CommandLine)"; created = $p.CreationDate; ppid = $pp }
    }
    $script:ProcInfo = $info
    return $t
}

# 셸 pid 아래(자식, 손자...)에서 Claude 세션을 찾는다
function Find-ClaudeUnder([int]$ShellPid, $Children, $Sessions) {
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue(@($ShellPid, 0))
    while ($queue.Count -gt 0) {
        $cur = $queue.Dequeue()
        if ($cur[0] -ne $ShellPid -and $Sessions.ContainsKey([int]$cur[0])) { return $Sessions[[int]$cur[0]] }
        if ($cur[1] -ge 3) { continue }
        foreach ($c in @($Children[[int]$cur[0]])) { if ($c) { $queue.Enqueue(@([int]$c, $cur[1] + 1)) } }
    }
    return $null
}

# ---------------------------------------------------------------- Codex (대화창 = codex TUI)
# Codex 는 Claude 처럼 "프로세스별 세션 파일"이 없다. 그래서 (1) 셸 아래 Codex 대화창 프로세스를 찾고,
# (2) 그 프로세스가 켜진 뒤 갱신된 TUI 대화 파일(rollout) 중 작업 폴더가 같은 것을 짝지어, 짝이 하나로 확정될 때만 기록한다.
# 확정이 안 되면(같은 폴더에 Codex 창이 둘 이상 등) 틀린 대화를 이어 붙이지 않도록 기록을 새로 쓰지 않는다.

# 프로세스 하나가 "사용자가 쓰는 Codex 대화창(TUI)"인지. 앱 서버/exec/MCP/컴퓨터 사용 보조 프로세스는 제외.
function Test-CodexTui($pi) {
    if (-not $pi) { return $false }
    $cmd = "$($pi.cmd)"
    if ($cmd -match 'app-server|\sexec(\s|-)|\smcp(\s|-server)|code-mode-host|computer-use') { return $false }
    if ("$($pi.name)" -ieq 'node.exe') { return ($cmd -match '@openai[\\/]codex[\\/]bin[\\/]codex\.js') }
    if ("$($pi.name)" -ieq 'codex.exe') { return $true }
    return $false
}

# 셸 pid 아래(자식, 손자...)에서 Codex 대화창을 찾는다. 반환: @{ pid; created } 또는 $null (Get-ChildTable 이 먼저 불려 있어야 함)
function Find-CodexUnder([int]$ShellPid, $Children) {
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue(@($ShellPid, 0))
    while ($queue.Count -gt 0) {
        $cur = $queue.Dequeue()
        $pi = $script:ProcInfo[[int]$cur[0]]
        if ($cur[0] -ne $ShellPid -and (Test-CodexTui $pi)) { return @{ pid = [int]$cur[0]; created = $pi.created; cmd = "$($pi.cmd)" } }
        if ($cur[1] -ge 3) { continue }
        foreach ($c in @($Children[[int]$cur[0]])) { if ($c) { $queue.Enqueue(@([int]$c, $cur[1] + 1)) } }
    }
    return $null
}

# 폴더 비교용 정규화(대소문자·끝 역슬래시·\\?\ 접두어 무시)
function ConvertTo-CwdKey([string]$p) {
    if (-not $p) { return '' }
    return ($p -replace '^\\\\\?\\', '').TrimEnd('\', '/').ToLowerInvariant()
}

# rollout 첫 줄(session_meta)은 변하지 않으므로 한 번 읽으면 캐시한다. Codex 가 쓰는 중이어도 읽을 수 있게 공유 모드로 연다.
$script:CodexHeadCache = @{}
function Get-CodexHead([string]$Path) {
    if ($script:CodexHeadCache.ContainsKey($Path)) { return $script:CodexHeadCache[$Path] }
    $h = $null
    try {
        $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try { $sr = New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8); $line = $sr.ReadLine() } finally { $fs.Dispose() }
        $pl = ($line | ConvertFrom-Json).payload
        if ($pl -and "$($pl.id)" -match $UuidRe) { $h = @{ id = "$($pl.id)"; cwd = "$($pl.cwd)"; orig = "$($pl.originator)"; sub = [bool]($pl.source -is [psobject]) } }
    } catch {}
    if ($h) { $script:CodexHeadCache[$Path] = $h }
    return $h
}

# Since 이후 갱신된 "사용자 대화창(codex-tui / codex_cli 계열, 하위 에이전트 아님)" 대화 파일 목록
function Get-CodexTuiCandidates([datetime]$Since) {
    $out = @()
    foreach ($root in (Get-CodexSessDirList)) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        try {
            foreach ($f in ([IO.DirectoryInfo]$root).EnumerateFiles('rollout-*.jsonl', [IO.SearchOption]::AllDirectories)) {
                if ($f.LastWriteTime -lt $Since) { continue }
                $h = Get-CodexHead $f.FullName
                if (-not $h -or $h.sub -or $h.orig -notmatch '^codex[-_](tui|cli)') { continue }
                $out += [pscustomobject]@{ id = $h.id; cwd = $h.cwd; key = (ConvertTo-CwdKey $h.cwd); mtime = $f.LastWriteTime; file = $f.FullName }
            }
        } catch {}
    }
    return $out
}

# 대화 ID 로 rollout 파일 경로를 찾는다(없으면 $null).
function Find-CodexRollout([string]$Sid) {
    if ($Sid -notmatch $UuidRe) { return $null }
    foreach ($root in (Get-CodexSessDirList)) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        try { $f = ([IO.DirectoryInfo]$root).EnumerateFiles("rollout-*-$Sid.jsonl", [IO.SearchOption]::AllDirectories) | Select-Object -First 1; if ($f) { return $f.FullName } } catch {}
    }
    return $null
}

# ---- 같은 폴더에 Codex 창이 여럿일 때: 화면 대조 ----------------------------------------------------------
# Codex 대화창은 최근 대화를 화면에 그대로 보여 준다. 후보 대화(rollout)의 최근 사용자/Codex 발화 문장이 어느 창 화면에 있는지로 짝을 가린다.
# 확정 조건: 창 하나가 후보 정확히 1개와만 맞고, 그 후보도 다른 창과 겹치지 않을 때. 하나라도 어긋나면 확정하지 않는다(틀린 대화를 이어 붙이지 않는다).
$script:CodexScreenReader = $null      # 시험에서만 가짜 화면을 주입한다: { param($addr) '화면 텍스트' }
$script:CodexScreenCache = @{}
$script:CodexSigCache = @{}
function ConvertTo-TextKey([string]$s) { return ("$s" -replace '\s+', '') }      # 화면에서는 긴 줄이 단어 중간에서도 접히므로 공백을 모두 무시하고 비교한다
function Get-CodexScreenKey([string]$Addr) {
    $c = $script:CodexScreenCache[$Addr]
    if ($c -and ((Get-Date) - $c.at).TotalSeconds -le 20) { return $c.key }
    $raw = ''
    try { $raw = $(if ($script:CodexScreenReader) { & $script:CodexScreenReader $Addr } else { (& hc read $Addr --lines 300 2>$null) -join "`n" }) } catch {}
    $k = ConvertTo-TextKey "$raw"
    $script:CodexScreenCache[$Addr] = @{ at = Get-Date; key = $k }
    return $k
}
# rollout 의 마지막 부분에서 사용자/Codex 발화 앞 48자를 뽑는다(안내문·환경 설명은 제외). 파일 크기가 같으면 캐시를 쓴다.
function Get-CodexSignatures([string]$File) {
    $fi = $null; try { $fi = Get-Item -LiteralPath $File -ErrorAction Stop } catch { return @() }
    $c = $script:CodexSigCache[$File]
    if ($c -and ($c.len -eq $fi.Length -or ((Get-Date) - $c.at).TotalSeconds -le 60)) { return $c.sigs }      # 쓰는 중인 파일을 매 라운드 다시 파싱하지 않도록 60초 캐시
    $texts = New-Object System.Collections.ArrayList
    try {
        $fs = [IO.File]::Open($File, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            $take = [int][Math]::Min([int64]196608, $fs.Length); [void]$fs.Seek($fs.Length - $take, [IO.SeekOrigin]::Begin)
            $buf = New-Object byte[] $take; [void]$fs.Read($buf, 0, $take)
        } finally { $fs.Dispose() }
        $lines = [Text.Encoding]::UTF8.GetString($buf) -split "`n"
        for ($i = 1; $i -lt $lines.Count; $i++) {     # 첫 줄은 잘렸을 수 있어 건너뛴다
            $ln = $lines[$i].Trim(); if (-not $ln.StartsWith('{')) { continue }
            $j = $null; try { $j = $ln | ConvertFrom-Json } catch { continue }
            if ($j.type -ne 'response_item' -or -not $j.payload -or $j.payload.type -ne 'message') { continue }
            $role = "$($j.payload.role)"; if ($role -ne 'user' -and $role -ne 'assistant') { continue }
            foreach ($part in @($j.payload.content)) {
                $t = "$($part.text)"; if (-not $t) { continue }
                if ($role -eq 'user' -and ($t -match '^# AGENTS\.md instructions' -or $t -match '<INSTRUCTIONS>|<environment_context>|<permissions instructions>')) { continue }
                [void]$texts.Add((ConvertTo-TextKey ($t -replace '</?hc[^>]*>', ' ')))
            }
        }
    } catch {}
    $sigs = @($texts | Where-Object { $_.Length -ge 20 } | Select-Object -Last 6 | ForEach-Object { $_.Substring(0, [Math]::Min(40, $_.Length)) } | Select-Object -Unique)   # 공백을 뺀 앞 40자(너무 짧은 발화는 근거로 쓰지 않는다)
    $script:CodexSigCache[$File] = @{ len = $fi.Length; sigs = $sigs; at = (Get-Date) }
    return $sigs
}
# $Windows: addr -> 후보 대화 목록. 반환: addr -> 확정된 후보 (확정 못 한 창은 빠진다)
function Resolve-CodexByScreen($Windows) {
    $match = @{}
    foreach ($a in @($Windows.Keys)) {
        $scr = Get-CodexScreenKey $a; $hit = @(); $blind = $false
        if ($scr) {
            foreach ($c in @($Windows[$a])) {
                $sigs = @(Get-CodexSignatures $c.file)
                if ($sigs.Count -eq 0) { $blind = $true; continue }        # 발화가 거의 없는 대화(방금 /new 등)는 화면과 대조할 수 없다
                foreach ($sg in $sigs) { if ($scr.Contains($sg)) { $hit += $c; break } }
            }
        }
        if ($blind) { $hit = @() }                                         # 대조할 수 없는 후보가 하나라도 있으면 이 창은 확정하지 않는다(그 후보가 진짜 주인일 수 있다)
        $match[$a] = $hit
    }
    $out = @{}
    foreach ($a in @($match.Keys)) {
        if (@($match[$a]).Count -ne 1) { continue }
        $c = @($match[$a])[0]; $clash = $false
        foreach ($b in @($match.Keys)) { if ($b -ne $a -and @($match[$b] | Where-Object { $_.id -eq $c.id }).Count -gt 0) { $clash = $true } }
        if (-not $clash) { $out[$a] = $c }
    }
    return $out
}

# Herdr 창(주소) -> Codex 대화 짝짓기.
#   $Terms: addr -> @{ g = hc get 결과; root = Find-CodexUnder 결과 }
# 반환: addr -> @{ status = 'ok' | 'ambiguous' | 'none'; id; cwd; file }
function Get-CodexPairs($Terms) {
    $res = @{}
    if ($Terms.Count -eq 0) { return $res }
    # 1순위(확정): `codex resume <ID>` 로 켠 창은 프로세스 명령줄에 대화 ID 가 있다. 같은 폴더에 창이 여러 개여도 틀릴 수 없으므로 바로 확정한다.
    # (키퍼가 복구한 창이 전부 이 모양이다.) 그 ID 의 대화 파일이 실제로 있을 때만 인정한다.
    $explicit = @{}
    foreach ($a in @($Terms.Keys)) {
        $m = [regex]::Match("$($Terms[$a].root.cmd)", '(?i)(?:^|[\s"\\/])codex(?:\.js|\.exe)?"?\s+resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|"|$)')
        if (-not $m.Success) { continue }
        $sid = $m.Groups[1].Value.ToLowerInvariant()
        $f = Find-CodexRollout $sid
        if (-not $f) { continue }
        $h = Get-CodexHead $f
        $explicit[$a] = $sid
        $res[$a] = @{ status = 'ok'; id = $sid; cwd = $(if ($h) { $h.cwd } else { '' }); file = $f; how = 'resume' }
    }
    $termTotal = $Terms.Count                        # Herdr 안에서 찾은 Codex 창 전체 수(아래 "Herdr 밖" 계산용)
    $rest = @{}; foreach ($a in $Terms.Keys) { if (-not $explicit.ContainsKey($a)) { $rest[$a] = $Terms[$a] } }
    if ($rest.Count -eq 0) { return $res }
    $Terms = $rest                                  # 아래 추정(폴더+갱신 시각)은 확정되지 않은 창만 대상으로 한다
    $since = @($Terms.Values | ForEach-Object { $_.root.created } | Sort-Object)[0].AddSeconds(-5)
    $cands = @(Get-CodexTuiCandidates $since | Where-Object { -not ($explicit.Values -contains $_.id) })   # 이미 다른 창이 확정한 대화는 후보에서 뺀다
    # Herdr 밖(다른 터미널)에서 도는 Codex 대화창이 있는지: 전체 대화창(루트) 수 - Herdr 안에서 찾은 수
    $roots = @($script:ProcInfo.Keys | Where-Object { (Test-CodexTui $script:ProcInfo[$_]) -and -not (Test-CodexTui $script:ProcInfo[[int]$script:ProcInfo[$_].ppid]) })
    $outside = [Math]::Max(0, $roots.Count - $termTotal)
    $cwdCount = @{}
    foreach ($a in $Terms.Keys) { $k = ConvertTo-CwdKey "$(if ($Terms[$a].g.foreground.cwd) { $Terms[$a].g.foreground.cwd } else { $Terms[$a].g.cwd })"; $cwdCount[$k] = 1 + [int]$cwdCount[$k] }
    $mineBy = @{}; $ambWhy = @{}
    foreach ($a in $Terms.Keys) {
        $t = $Terms[$a]
        $k = ConvertTo-CwdKey "$(if ($t.g.foreground.cwd) { $t.g.foreground.cwd } else { $t.g.cwd })"
        $mineBy[$a] = @($cands | Where-Object { $_.key -eq $k -and $_.mtime -ge $t.root.created.AddSeconds(-5) } | Sort-Object mtime -Descending)
        if ($mineBy[$a].Count -eq 0) { continue }
        if ($cwdCount[$k] -gt 1) { $ambWhy[$a] = '같은 폴더에 Codex 창이 둘 이상' }
        elseif ($mineBy[$a].Count -gt 1 -and $outside -gt 0) { $ambWhy[$a] = 'Herdr 밖에서도 Codex 가 실행 중이라 대화를 가릴 수 없음' }
    }
    # 모호한 창만 "화면에 그 대화의 최근 문장이 보이는지"로 한 번 더 가린다(창과 대화가 서로 유일하게 맞을 때만 확정)
    $screen = @{}
    if ($ambWhy.Count -gt 0) { $need = @{}; foreach ($a in $ambWhy.Keys) { $need[$a] = $mineBy[$a] }; $screen = Resolve-CodexByScreen $need }
    foreach ($a in $Terms.Keys) {
        $mine = $mineBy[$a]
        if ($mine.Count -eq 0) { $res[$a] = @{ status = 'none' }; continue }
        if ($ambWhy.ContainsKey($a)) {
            if ($screen.ContainsKey($a)) { $c = $screen[$a]; $res[$a] = @{ status = 'ok'; id = $c.id; cwd = $c.cwd; file = $c.file; how = 'screen' }; continue }
            $res[$a] = @{ status = 'ambiguous'; why = $ambWhy[$a] }; continue
        }
        $res[$a] = @{ status = 'ok'; id = $mine[0].id; cwd = $mine[0].cwd; file = $mine[0].file }
    }
    return $res
}

# 지금 실행 중인 Codex 대화(복구 판단에서 "이미 실행 중"인지 보기 위함). hc 가 agent=codex 로 표시한 창만 훑는다.
$script:CodexLiveCache = @{ at = [datetime]::MinValue; sids = @{} }
function Get-CodexLiveSids($Children) {
    if (((Get-Date) - $script:CodexLiveCache.at).TotalSeconds -le 5) { return $script:CodexLiveCache.sids }
    $terms = @{}
    $ls = Invoke-HcJson @('ls')
    foreach ($t in @($ls.terminals)) {
        if ($t.state -ne 'live' -or "$($t.agent)" -notmatch 'codex') { continue }
        $g = Invoke-HcJson @('get', $t.address)
        if (-not $g -or -not $g.foreground.pid) { continue }
        $r = Find-CodexUnder ([int]$g.foreground.pid) $Children
        if ($r) { $terms[$t.address] = @{ g = $g; root = $r } }
    }
    $sids = @{}
    $pairs = Get-CodexPairs $terms
    foreach ($a in $pairs.Keys) { if ($pairs[$a].status -eq 'ok') { $sids[$pairs[$a].id] = $true } }
    $script:CodexLiveCache = @{ at = Get-Date; sids = $sids }
    return $sids
}

function Test-CodexRolloutExists($e) {
    $f = "$(Get-Prop $e 'file' '')"
    if ($f -and (Test-Path -LiteralPath $f)) { return $true }
    return [bool](Find-CodexRollout "$($e.sid)")
}

function Test-SessionFileExists([string]$Sid, [string]$Cwd = '') {
    # 빠른 길: Claude 는 대화를 projects\<작업폴더를 '-'로 바꾼 이름>\<세션ID>.jsonl 에 저장한다(전체 탐색은 약 3초).
    if ($Cwd) {
        $slug = $Cwd -replace '[^A-Za-z0-9]', '-'
        if (Test-Path -LiteralPath (Join-Path $ProjDir "$slug\$Sid.jsonl")) { return $true }
    }
    return [bool](Get-ChildItem $ProjDir -Recurse -Filter "$Sid.jsonl" -File -ErrorAction SilentlyContinue | Select-Object -First 1)
}

# 사라진 창이 "사용자가 직접 닫은 것('user')"인지 "사고 또는 불확실('keep')"인지 판정(입출력 없는 순수 함수).
#  user = 같은 Herdr(코어)가 계속 떠 있고(살아 있는 창이 1개 이상) 그 창의 종료 기록이 finished/killed 로 남아 있음(탭·공간·패널 닫기)
#  keep = 종료 기록을 못 찾음(코어가 새로 떴거나 정리됨) / killed 가 아님(스스로 종료·충돌 등) / 살아 있는 창이 0개(앱 전체 종료 중)
function Get-CloseVerdict($Gz, [int]$LiveCount) {
    if (-not $Gz) { return 'keep' }
    if ("$($Gz.state)" -ne 'finished') { return 'keep' }
    if ("$($Gz.reason)" -ne 'killed') { return 'keep' }
    if ($LiveCount -lt 1) { return 'keep' }
    return 'user'
}

# 같은 시각에 한꺼번에 죽은 창 묶음 찾기: MassSec 안에 MassCount 개 이상이면 전부 "사고"로 표시
function Get-MassSet($Items, [int]$Count, [int]$Sec) {
    $res = @{}
    $s = @($Items | Sort-Object { $_.ms })
    for ($i = 0; $i -lt $s.Count; $i++) {
        $w = @($s | Where-Object { $_.ms -ge $s[$i].ms -and $_.ms -le ($s[$i].ms + $Sec * 1000) })
        if ($w.Count -ge $Count) { foreach ($x in $w) { $res[$x.addr] = $true } }
    }
    return $res
}

# ---------------------------------------------------------------- Snapshot
$script:CodexWarned = @{}
function Invoke-Snapshot {
    $boot = Get-BootId
    $ls = Invoke-HcJson @('ls')
    if (-not $ls) { return }                      # 코어가 아직 없으면 기록을 건드리지 않는다
    $map = Read-Map
    $sess = Get-ClaudeSessions
    # 탐지 실패 방어: Claude 프로세스는 떠 있는데 세션 파일을 하나도 못 읽었다면(폴더 이동/형식 변경 등)
    # "Claude 가 끝났다"고 오해해 기록을 지우지 않도록 이번 회차는 건드리지 않는다.
    if ($sess.Count -eq 0 -and (Get-Process claude -ErrorAction SilentlyContinue)) {
        if (-not $script:WarnedDetect) { Write-Log '경고: Claude 프로세스는 있는데 세션 파일을 읽지 못했습니다. 기록을 보호하려고 이번 회차는 건너뜁니다.'; $script:WarnedDetect = $true }
        return
    }
    $script:WarnedDetect = $false
    $kids = Get-ChildTable
    $layout = Get-LayoutTable (Get-AppLs)
    $now = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
    $seen = @{}; $liveHit = @{}; $codexTerms = @{}
    foreach ($t in @($ls.terminals)) {
        if ($t.state -ne 'live') { continue }
        $seen[$t.address] = $true
        $g = Invoke-HcJson @('get', $t.address)
        if (-not $g -or -not $g.foreground.pid) { continue }
        $hit = Find-ClaudeUnder ([int]$g.foreground.pid) $kids $sess
        $cx = $null; if (-not $hit) { $cx = Find-CodexUnder ([int]$g.foreground.pid) $kids }
        $old = $map[$t.address]
        if ($hit) {
            $L = $layout[$t.address]
            $liveHit[$t.address] = $true
            $map[$t.address] = [pscustomobject]@{
                addr = $t.address; where = "$($g.labels.where)"
                space = $(if ($L) { $L.space } else { Get-Prop $old 'space' '' })
                tab = $(if ($L) { $L.tab } else { Get-Prop $old 'tab' '' })
                spaceId = $(if ($L) { $L.spaceId } else { Get-Prop $old 'spaceId' '' })
                tabId = $(if ($L) { $L.tabId } else { "$($g.labels.'herdr.tab')" })
                sid = "$($hit.sessionId)"; cwd = "$($hit.cwd)"
                boot = $boot; seen = $now; miss = 0; orphan = $false; attempts = 0
            }
        } elseif ($cx) {
            $codexTerms[$t.address] = @{ g = $g; root = $cx }        # Codex 대화창이 떠 있는 창: 아래에서 대화와 짝짓는다
        } elseif ($old -and $old.boot -eq $boot -and -not (Get-Prop $old 'orphan' $false)) {
            # 이번 부팅 중 Claude 가 사라진 창. 종료 중 Claude 만 먼저 죽었을 수 있어 2번 연속일 때만 "직접 종료"로 본다.
            Set-Prop $old 'miss' (1 + [int](Get-Prop $old 'miss' 0))
        }
    }
    # Codex: 대화와 짝이 하나로 확정되면 기록. 확정이 안 되면(애매/아직 대화 없음) 새로 쓰지 않고, 이미 있던 기록은 그대로 둔다.
    if ($codexTerms.Count -gt 0) {
        $pairs = Get-CodexPairs $codexTerms
        foreach ($a in @($codexTerms.Keys)) {
            $p = $pairs[$a]; $old = $map[$a]; $g = $codexTerms[$a].g; $L = $layout[$a]
            if ($p -and $p.status -eq 'ok') {
                $liveHit[$a] = $true
                $map[$a] = [pscustomobject]@{
                    addr = $a; where = "$($g.labels.where)"
                    space = $(if ($L) { $L.space } else { Get-Prop $old 'space' '' })
                    tab = $(if ($L) { $L.tab } else { Get-Prop $old 'tab' '' })
                    spaceId = $(if ($L) { $L.spaceId } else { Get-Prop $old 'spaceId' '' })
                    tabId = $(if ($L) { $L.tabId } else { "$($g.labels.'herdr.tab')" })
                    sid = $p.id; cwd = $p.cwd; tool = 'codex'; file = $p.file
                    boot = $boot; seen = $now; miss = 0; orphan = $false; attempts = 0
                }
            } else {
                # 아직 대화가 없거나 애매함: Codex 가 떠 있는 창이므로 사라진 것으로 세지 않는다(기존 기록 유지)
                if ($old -and "$(Get-Prop $old 'tool' '')" -eq 'codex' -and $old.boot -eq $boot -and -not (Get-Prop $old 'orphan' $false)) { $liveHit[$a] = $true; Set-Prop $old 'seen' $now; Set-Prop $old 'miss' 0 }
                if ($p -and $p.status -eq 'ambiguous' -and -not $script:CodexWarned.ContainsKey($a)) { $script:CodexWarned[$a] = $true; Write-Log "Codex 창 $a [$($g.labels.where)]: 대화를 하나로 정할 수 없어 기록하지 않습니다($($p.why))" }
            }
        }
    }
    # 한꺼번에 사라짐 = 사고: 이번 부팅에서 기록된 창 중 Claude 가 없어진 것이 MassCount 개 이상이면(Herdr 가 갑자기
    # 닫혔다 열려 창이 빈 셸로 돌아오거나 끝나 버린 경우, 종료 중 Claude 가 먼저 죽은 경우) 사용자가 하나씩 끝낸 것이 아니므로
    # 지우지 않고 복구 대상(orphan)으로 보존한다. 1~2개만 사라지면 아래 기존 규칙(직접 종료로 보고 정리)을 따른다.
    # (창 자체가 닫힌 경우는 아래 Get-CloseVerdict 가 따로 판정한다. 여기서는 "창은 살아 있는데 Claude 만 사라진" 새 건만 센다.
    #  이미 대기 중인 항목을 세면 대기 목록이 쌓인 뒤로는 창 하나만 닫아도 "일괄 소실"로 오판했다 - 2026-11-10 로그 22:31 t13z)
    $vanished = @($map.Keys | Where-Object { $map[$_].boot -eq $boot -and -not $liveHit.ContainsKey($_) -and $seen.ContainsKey($_) -and -not (Get-Prop $map[$_] 'orphan' $false) })
    if ($vanished.Count -ge $MassCount) {
        foreach ($k in $vanished) {
            $e = $map[$k]
            if (-not (Get-Prop $e 'orphan' $false)) {
                Set-Prop $e 'orphan' $true; Set-Prop $e 'orphanAt' $now; Set-Prop $e 'miss' 0
                Write-Log "일괄 소실 감지: $k [$($e.where)] 기록 보존 (Herdr 를 다시 켜면 복구)"
            }
        }
    }
    # 창 자체가 닫히거나 끝난 항목. 2026-11-03 에는 전부 보존했지만, 사용자가 일부러 닫은 창까지 되살아나는 문제(2026-11-11)가 있어
    # Get-CloseVerdict 로 "직접 닫음"과 "사고"를 가른다. 직접 닫음은 목록에서 빼고(로그에 세션ID를 남김), 사고·불확실은 보존한다.
    # 보존된 것은 다음에 Herdr 를 켜면(또는 로그인하면) 새 탭으로 되살아난다. 영영 끝낸 작업은 `-Mode Forget -Sid <앞 8자>` 로 뺀다.
    foreach ($k in @($map.Keys)) {
        $e = $map[$k]
        if ($e.boot -ne $boot -or $seen.ContainsKey($k) -or (Get-Prop $e 'orphan' $false)) { continue }
        # 왜 끝났는지(killed=탭/공간/패널 닫기·강제 종료, exited=스스로 종료 등)를 확인한다 - 원인을 추측하지 않는다
        $gz = Invoke-HcJson @('get', $k)
        $why = ' / 종료 이유 조회 불가(이미 정리됨)'
        if ($gz -and $gz.state -eq 'finished') {
            $fin = ''; try { $fin = ' ' + [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$gz.finished_ms).LocalDateTime.ToString('HH:mm:ss') } catch {}
            $why = " / 종료 이유=$($gz.reason) 종료코드=$($gz.exit_code)$fin"
        }
        if ((Get-CloseVerdict $gz $seen.Count) -eq 'user') {
            Write-Log "직접 닫은 창: $k [$($e.where)] sid $($e.sid) -> 복구 목록에서 제외 (다시 열려면 $(if ("$(Get-Prop $e 'tool' '')" -eq 'codex') { 'codex resume' } else { 'claude --resume' }) $($e.sid))$why"
            $map.Remove($k); continue
        }
        Set-Prop $e 'orphan' $true; Set-Prop $e 'orphanAt' $now; Set-Prop $e 'miss' 0
        Write-Log "창이 닫히거나 끝남: $k [$($e.where)] sid $("$($e.sid)".Substring(0, 8)) -> 기록 보존 (Herdr 를 다시 켜면 복구)$why"
    }
    foreach ($k in @($map.Keys)) {
        $e = $map[$k]
        # 창은 열려 있는데 Claude 만 끝낸 경우(/exit 등)만 2번 확인 뒤 정리
        if ($e.boot -eq $boot -and -not (Get-Prop $e 'orphan' $false) -and [int](Get-Prop $e 'miss' 0) -ge 2) { $map.Remove($k); continue }
        # 보관 기한: 아주 오래 꺼 둔 뒤에도 남도록 1년(복구 대기 중이어도 이 기한까지는 지우지 않는다)
        try { if (((Get-Date) - [datetime]$e.seen).TotalDays -gt $TtlDays) { $map.Remove($k) } } catch {}
    }
    # 같은 세션이 두 항목에 있으면 살아 있는(또는 최신) 항목만 남긴다
    $bySid = @{}
    foreach ($k in $map.Keys) { $s = "$($map[$k].sid)"; if (-not $bySid.ContainsKey($s)) { $bySid[$s] = @() }; $bySid[$s] += $k }
    foreach ($s in $bySid.Keys) {
        $ks = @($bySid[$s]); if ($ks.Count -lt 2) { continue }
        $keep = @($ks | Where-Object { $liveHit.ContainsKey($_) }) | Select-Object -First 1
        if (-not $keep) { $keep = @($ks | Sort-Object { $map[$_].seen } -Descending) | Select-Object -First 1 }
        foreach ($k in $ks) { if ($k -ne $keep) { $map.Remove($k) } }
    }
    Save-Map $map
}

# ---------------------------------------------------------------- Recover
# 판단만 하는 함수(입출력 없음) - 시험하기 쉽게 분리. 반환: Action(TYPE/CREATE/SKIP), Reason, Retry(나중에 다시 볼 가치가 있는지)
function Get-Decision($e, $g, $ctx) {
    $sid = "$($e.sid)"
    if ($sid -notmatch $UuidRe) { return @{ Action = 'SKIP'; Reason = '세션ID 형식 오류'; Retry = $false } }
    if ($ctx.Running.ContainsKey($sid)) { return @{ Action = 'SKIP'; Reason = '같은 대화가 이미 실행 중'; Retry = $false } }
    if ([int](Get-Prop $e 'attempts' 0) -ge $ctx.MaxAttempts) { return @{ Action = 'SKIP'; Reason = "시도 $($ctx.MaxAttempts)회 초과"; Retry = $false } }
    $chk = $(if ($ctx.ContainsKey('CheckFile')) { $ctx.CheckFile } else { $ctx.ClaudeTemplate })   # Claude/Codex 각자의 대화 파일 확인 여부
    if ($chk -and -not $ctx.JsonlOk) { return @{ Action = 'SKIP'; Reason = '대화 파일(.jsonl)이 없음'; Retry = $false } }
    if ($g -and $g.state -eq 'live') {
        $wantTab = "$(Get-Prop $e 'tabId' '')"; $haveTab = "$($g.labels.'herdr.tab')"
        if ($wantTab -and $haveTab) { if ($wantTab -ne $haveTab) { return @{ Action = 'SKIP'; Reason = "탭이 다름(기록 $wantTab / 지금 $haveTab)"; Retry = $false } } }
        elseif ("$($g.labels.where)" -ne "$($e.where)") { return @{ Action = 'SKIP'; Reason = "창 이름이 다름(기록 $($e.where) / 지금 $($g.labels.where))"; Retry = $false } }
        if ($ctx.HasClaude) { return @{ Action = 'SKIP'; Reason = '그 창에서 다른 Claude 가 실행 중'; Retry = $false } }
        if ($g.foreground.name -ne 'powershell.exe') { return @{ Action = 'SKIP'; Reason = "앞 프로그램이 powershell 아님($($g.foreground.name))"; Retry = $true } }
        if ($ctx.LastLine -notmatch '^PS .+>\s*$') { return @{ Action = 'SKIP'; Reason = "빈 PS 프롬프트가 아님: $($ctx.LastLine)"; Retry = $true } }
        return @{ Action = 'TYPE'; Reason = '빈 셸, 입력 가능'; Retry = $false }
    }
    if (-not $ctx.AllowCreate) { return @{ Action = 'SKIP'; Reason = '창이 없음 - 코어 유예 시간 뒤 새 탭으로 복구 예정'; Retry = $true } }
    return @{ Action = 'CREATE'; Reason = '창이 끝나 있음 - 새 탭으로 복구'; Retry = $false }
}

# 판단용 프로세스 정보는 5초 동안 재사용한다(창마다 새로 조회하면 24개에 1분 가까이 걸림).
$script:ProcCache = @{ at = [datetime]::MinValue; sess = $null; kids = $null }
function Get-ProcSnapshot {
    if (((Get-Date) - $script:ProcCache.at).TotalSeconds -gt 5) {
        $script:ProcCache.sess = Get-ClaudeSessions; $script:ProcCache.kids = Get-ChildTable; $script:ProcCache.at = Get-Date
    }
    return $script:ProcCache
}

function Get-EntryDecision($e, [bool]$AllowCreate) {
    $snap = Get-ProcSnapshot
    $sess = $snap.sess
    $isCodex = ("$(Get-Prop $e 'tool' 'claude')" -eq 'codex')
    $ctx = @{
        Running = @{}; AllowCreate = $AllowCreate; JsonlOk = $true; HasClaude = $false; LastLine = ''
        MaxAttempts = $MaxAttempts; ClaudeTemplate = $IsClaudeTemplate
        CheckFile = $(if ($isCodex) { $IsCodexTemplate } else { $IsClaudeTemplate })
    }
    foreach ($v in $sess.Values) { $ctx.Running["$($v.sessionId)"] = $true }
    if ($isCodex) { foreach ($k in @((Get-CodexLiveSids $snap.kids).Keys)) { $ctx.Running["$k"] = $true } }
    # 같은 대화가 이미 실행 중이면 더 알아볼 필요 없이 바로 결정(가장 흔한 경우를 빠르게)
    if ("$($e.sid)" -match $UuidRe -and $ctx.Running.ContainsKey("$($e.sid)")) { return (Get-Decision $e $null $ctx) }
    $g = Invoke-HcJson @('get', $e.addr)
    if ($ctx.CheckFile -and "$($e.sid)" -match $UuidRe) { $ctx.JsonlOk = $(if ($isCodex) { Test-CodexRolloutExists $e } else { Test-SessionFileExists "$($e.sid)" "$($e.cwd)" }) }
    if ($g -and $g.state -eq 'live') {
        $ctx.HasClaude = [bool]((Find-ClaudeUnder ([int]$g.foreground.pid) $snap.kids $sess) -or (Find-CodexUnder ([int]$g.foreground.pid) $snap.kids))   # 다른 AI(Claude/Codex)가 이미 떠 있으면 입력하지 않는다
        $scr = (& hc read $e.addr --lines 4 2>$null) -join "`n"
        $ctx.LastLine = ($scr -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
    }
    return (Get-Decision $e $g $ctx)
}

# 한 창이 지금 복구 완료 상태인지 한 번 확인한다. 반환: 대화 정보(성공) | 'NOT-FOUND' | 'TEST-OK' | $null(아직)
function Test-ResumeUp([string]$Addr, $Entry = $null, $Kids = $null, $Sess = $null) {
    $isCodex = ($Entry -and "$(Get-Prop $Entry 'tool' 'claude')" -eq 'codex')
    $g = Invoke-HcJson @('get', $Addr)
    $scr = (& hc read $Addr --lines 8 2>$null) -join "`n"
    if ($isCodex) {
        # Codex: 화면에 "대화 없음" 오류가 보이면 실패, 아니면 셸 아래에 Codex 대화창 프로세스가 뜬 것으로 성공 확인
        if ($scr -match '(?i)no (saved )?(session|conversation|thread)s? (found|with)') { return 'NOT-FOUND' }
        if ($g -and $g.foreground.pid) {
            $k = $(if ($Kids) { $Kids } else { Get-ChildTable })
            if (Find-CodexUnder ([int]$g.foreground.pid) $k) { return [pscustomobject]@{ sessionId = "$($Entry.sid)"; cwd = "$($Entry.cwd)" } }
        }
        if (-not $IsCodexTemplate -and $scr -match '(?m)^RESTORED-') { return 'TEST-OK' }   # 시험용 템플릿 전용
        return $null
    }
    if ($g -and $g.foreground.pid) {
        $k = $(if ($Kids) { $Kids } else { Get-ChildTable }); $s = $(if ($Sess) { $Sess } else { Get-ClaudeSessions })
        $hit = Find-ClaudeUnder ([int]$g.foreground.pid) $k $s
        if ($hit) { return $hit }
    }
    if ($scr -match 'No conversation found') { return 'NOT-FOUND' }
    if (-not $IsClaudeTemplate -and $scr -match '(?m)^RESTORED-') { return 'TEST-OK' }   # 시험용 템플릿 전용
    return $null
}

# 한 창을 최대 60초 기다린다(5초 간격).
function Wait-ClaudeUp([string]$Addr, $Entry = $null) {
    for ($i = 0; $i -lt 12; $i++) {
        Start-Sleep -Seconds 5
        $r = Test-ResumeUp $Addr $Entry
        if ($null -ne $r) { return $r }
    }
    return $null
}

# 여러 창을 한꺼번에 기다린다(묶음 단위). 창마다 따로 5초씩 기다리면 묶음 하나가 15~30초 걸렸다 -> 3초마다 전부 한 번에 확인, 전체 최대 60초.
# 프로세스 목록은 확인 한 바퀴에 한 번만 읽는다. 반환: 주소 -> 결과(Test-ResumeUp 과 같은 값, 시간 안에 못 끝나면 $null)
function Wait-ClaudeUpMany($Entries, [int]$MaxSec = 60) {
    $res = @{}
    $pend = @($Entries)
    $t0 = Get-Date
    while ($pend.Count -gt 0 -and ((Get-Date) - $t0).TotalSeconds -lt $MaxSec) {
        Start-Sleep -Seconds 3
        $kids = Get-ChildTable; $sess = Get-ClaudeSessions
        $next = @()
        foreach ($e in $pend) {
            $r = Test-ResumeUp $e.addr $e $kids $sess
            if ($null -ne $r) { $res[$e.addr] = $r } else { $next += , $e }
        }
        $pend = @($next)
    }
    foreach ($e in $pend) { $res[$e.addr] = $null }
    return $res
}

function Mark-Done($e, [string]$boot) {
    $map = Read-Map
    if ($map.ContainsKey($e.addr)) { Set-Prop $map[$e.addr] 'boot' $boot; Set-Prop $map[$e.addr] 'orphan' $false; Save-Map $map }
}
function Add-Attempt($e) {
    $map = Read-Map
    if ($map.ContainsKey($e.addr)) { Set-Prop $map[$e.addr] 'attempts' (1 + [int](Get-Prop $map[$e.addr] 'attempts' 0)); Save-Map $map }
}

# 빈 셸에 입력만 한다(실행 확인은 기다리지 않음). 반환: 'SENT' | 'SEND-FAIL'
function Send-ResumeInput($e) {
    $cwd = "$($e.cwd)"; $pre = ''
    if ($cwd -and (Test-Path -LiteralPath $cwd)) { $pre = "Set-Location -LiteralPath '" + $cwd.Replace("'", "''") + "'; " }
    else { Write-Log "$($e.addr) 기록된 작업 폴더가 없어 현재 폴더에서 실행합니다: $cwd" }
    $tpl = $(if ("$(Get-Prop $e 'tool' 'claude')" -eq 'codex') { $CodexTemplate } else { $Template })
    $cmd = $pre + ($tpl -f $e.sid)
    & hc send $e.addr $cmd 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Log "$($e.addr) 입력 실패(hc send 코드 $LASTEXITCODE)"; Add-Attempt $e; return 'SEND-FAIL' }
    Write-Log "$($e.addr) [$($e.where)] 빈 셸에 입력: $cmd"
    return 'SENT'
}

# 실행 확인 결과($r)를 기록에 반영한다. 반환: 'OK' | 'NOT-FOUND' | 'TIMEOUT'
function Complete-Resume($e, $r, [string]$boot) {
    if ($r -and $r -ne 'NOT-FOUND') { Write-Log "$($e.addr) 성공: 실행 확인"; Mark-Done $e $boot; return 'OK' }
    if ($r -eq 'NOT-FOUND') { Write-Log "$($e.addr) 실패: 대화를 찾을 수 없음"; $m = Read-Map; if ($m.ContainsKey($e.addr)) { Set-Prop $m[$e.addr] 'attempts' 99; Save-Map $m }; return 'NOT-FOUND' }
    Write-Log "$($e.addr) 60초 안에 확인되지 않음 - 화면 확인 필요"
    $m = Read-Map; if ($m.ContainsKey($e.addr)) { Set-Prop $m[$e.addr] 'attempts' 99; Save-Map $m }   # 중복 입력 방지
    return 'TIMEOUT'
}

# 빈 셸에 입력하고 실행 확인까지 기다린다(한 창씩 처리하는 기존 방식. 복구 라운드는 묶음 단위로 Send-ResumeInput + Wait-ClaudeUpMany 를 쓴다).
function Send-Resume($e, [string]$boot) {
    $s = Send-ResumeInput $e
    if ($s -ne 'SENT') { return $s }
    return (Complete-Resume $e (Wait-ClaudeUp $e.addr $e) $boot)
}

# 끝난 창 자리에 새 탭 생성
function New-ResumeTab($e, [string]$boot) {
    $appLs = Get-AppLs
    if (-not $appLs) { Write-Log "$($e.addr) Herdr 앱이 응답하지 않아 다음 라운드에 재시도"; return 'NO-APP' }
    $spaceName = "$(Get-Prop $e 'space' '')"; $tabName = "$(Get-Prop $e 'tab' '')"
    if (-not $spaceName -and "$($e.where)" -match ' / ') { $parts = "$($e.where)" -split ' / ', 2; $spaceName = $parts[0]; if (-not $tabName) { $tabName = $parts[1] } }
    $folder = "$($e.cwd)"; if (-not $folder -or -not (Test-Path -LiteralPath $folder)) { $folder = $env:USERPROFILE }
    $tool = "$(Get-Prop $e 'tool' 'claude')"
    $tpl = $(if ($tool -eq 'codex') { $CodexTemplate } else { $Template })
    $argvJson = ConvertTo-Json -InputObject @(($tpl -f $e.sid) -split ' ') -Compress
    $sp = @($appLs.spaces) | Where-Object { $_.name -eq $spaceName -and -not $_.machine } | Select-Object -First 1
    if ($sp) {
        $a = @('do', 'tab.new', '--space', "$($sp.id)")
        if ($tabName) { $a += @('--name', $tabName) }
    } else {
        $a = @('do', 'space.new')
        if ($spaceName) { $a += @('--name', $spaceName) }
        if ($tabName) { $a += @('--tab', $tabName) }
    }
    $a += @('--folder', $folder, '--argv', $argvJson)
    $sel0 = Get-Selection $appLs                       # 만들기 직전의 화면 선택
    $r = Invoke-App $a
    # tab.new/space.new 는 화면 선택을 새 탭으로 옮긴다 -> 우리가 옮긴 경우에만(몇 초 안에) 즉시 되돌린다.
    # 라운드가 끝난 뒤 한꺼번에 되돌리면 그 사이 사용자가 직접 이동한 화면을 덮어쓰게 된다.
    Start-Sleep -Milliseconds 1200
    $cur = Get-Selection (Get-AppLs)
    if ($sel0 -and $cur -and ($cur.space -ne $sel0.space -or $cur.tab -ne $sel0.tab)) {
        Restore-Selection $sel0
        Write-Log "$($e.addr) 화면 선택이 바뀌어(공간 $($cur.space)) 원래 위치로 되돌림(공간 $($sel0.space))"
    }
    $o = $null; try { $o = $r.Out | ConvertFrom-Json } catch {}
    if ($r.Code -ne 0 -or -not $o -or -not $o.terminal) { Write-Log "$($e.addr) 새 탭 생성 실패(코드 $($r.Code)): $($r.Out) $($r.Err)"; Add-Attempt $e; return 'ERR' }
    Write-Log "$($e.addr) [$spaceName / $tabName] -> 새 탭 $($o.tab) (창 $($o.terminal)) 생성: $($tpl -f $e.sid)"
    $w = Wait-ClaudeUp "$($o.terminal)" $e
    $map = Read-Map
    if ($w -and $w -ne 'NOT-FOUND') {
        Write-Log "$($e.addr) -> $($o.terminal) 성공: 실행 확인"
        if ($map.ContainsKey($e.addr)) { $map.Remove($e.addr) }
        if ($w -ne 'TEST-OK') {
            $map["$($o.terminal)"] = [pscustomobject]@{
                addr = "$($o.terminal)"; where = "$spaceName / $tabName"; space = $spaceName; tab = $tabName
                spaceId = "$($o.space)"; tabId = "$($o.tab)"; sid = "$($w.sessionId)"; cwd = "$($w.cwd)"
                boot = $boot; seen = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss'); miss = 0; orphan = $false; attempts = 0
            }
            if ($tool -eq 'codex') { Set-Prop $map["$($o.terminal)"] 'tool' 'codex'; Set-Prop $map["$($o.terminal)"] 'file' "$(Get-Prop $e 'file' '')" }
        }
        Save-Map $map
        return 'OK'
    }
    Write-Log "$($e.addr) -> $($o.terminal) 확인 실패($(if ($w) { $w } else { '60초 초과' })) - 화면 확인 필요, 이 항목은 더 이상 자동 시도하지 않음"
    if ($map.ContainsKey($e.addr)) { Set-Prop $map[$e.addr] 'attempts' 99; Save-Map $map }
    return 'TIMEOUT'
}

# ---------------------------------------------------------------- 결과 요약 / 알림 (비개발자도 한눈에 확인)
$SummaryFile = Join-Path $Dir 'LAST-RESTORE.txt'
$HistoryFile = Join-Path $Dir 'restore-history.log'
$script:Outcome = @{}          # 창 주소 -> 결과(성공/실패/건너뜀/대기)
$script:SidByAddr = @{}        # 창 주소 -> 세션ID (요약에 앞 8자를 보여 주기 위함)
$script:WinOpenAt = ''
$script:PrevInfo = ''

function Set-Outcome([string]$Addr, [string]$Where, [string]$State, [string]$Detail) {
    $script:Outcome[$Addr] = [pscustomobject]@{ addr = $Addr; where = $Where; state = $State; detail = $Detail; at = (Get-Date).ToString('HH:mm:ss') }
}

# 직전 종료 정보(원인 추적용): Windows 종료 기록 + 대기 기록 중 한꺼번에 끝난 창 묶음
function Get-PreviousShutdownInfo {
    $parts = @(); $sdTime = $null
    try {
        $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
        $evs = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 1074, 41, 6008; StartTime = $boot.AddDays(-2) } -ErrorAction SilentlyContinue)
        $unexpected = @($evs | Where-Object { ($_.Id -eq 41 -or $_.Id -eq 6008) -and [math]::Abs(($_.TimeCreated - $boot).TotalMinutes) -lt 3 }).Count -gt 0
        $sd = $evs | Where-Object { $_.Id -eq 1074 -and $_.TimeCreated -lt $boot } | Sort-Object TimeCreated -Descending | Select-Object -First 1
        if ($unexpected) { $parts += 'Windows: 비정상 종료(정전/강제 종료) 기록 있음' }
        elseif ($sd) {
            $sdTime = $sd.TimeCreated
            $kind = if ($sd.Message -match '다시 시작|restart') { '다시 시작' } elseif ($sd.Message -match '전원 끄기|shutdown|power off') { '전원 끄기' } else { '종료' }
            $parts += ('Windows: {0} 요청 {1:HH:mm:ss}' -f $kind, $sdTime)
        } else { $parts += 'Windows: 종료 기록을 찾지 못함' }
    } catch { $parts += 'Windows 종료 기록 조회 실패' }
    try {
        $bootId = Get-BootId; $map = Read-Map; $items = @(); $live = 0; $reasons = @{}
        foreach ($e in @($map.Values | Where-Object { $_.boot -ne $bootId -or (Get-Prop $_ 'orphan' $false) })) {
            $g = Invoke-HcJson @('get', $e.addr)
            if ($g -and $g.state -eq 'finished' -and $g.finished_ms) { $items += @{ addr = $e.addr; ms = [int64]$g.finished_ms }; $rk = "$($g.reason)"; $reasons[$rk] = 1 + [int]$reasons[$rk] }
            elseif ($g -and $g.state -eq 'live') { $live++ }
        }
        $parts += "대기 기록 중 빈 셸로 되살아난 창 $live 개 / 끝난 창 $($items.Count) 개"
        if ($reasons.Count -gt 0) { $parts += ('끝난 창의 종료 이유: ' + ((@($reasons.Keys | Sort-Object) | ForEach-Object { "$_ $($reasons[$_])개" }) -join ', ')) }
        $mass = Get-MassSet $items $MassCount $MassSec
        if ($mass.Count -gt 0) {
            $ms = @($items | Where-Object { $mass.ContainsKey($_.addr) } | ForEach-Object { $_.ms } | Sort-Object)
            $f = [DateTimeOffset]::FromUnixTimeMilliseconds($ms[0]).LocalDateTime; $l = [DateTimeOffset]::FromUnixTimeMilliseconds($ms[$ms.Count - 1]).LocalDateTime
            $txt = ('끝난 창 중 {0}개가 {1:HH:mm:ss}~{2:HH:mm:ss}에 한꺼번에 종료됨' -f $mass.Count, $f, $l)
            if ($sdTime) { $lead = ($sdTime - $f).TotalSeconds; if ($lead -gt 0) { $txt += (' (Windows 종료 요청보다 {0:N0}초 먼저)' -f $lead) } }
            $parts += $txt
        }
    } catch { $parts += '창 종료 시각 조회 실패' }
    return ($parts -join ' / ')
}

function Show-Toast([string]$Title, [string]$Body) {
    try {
        [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
        $t = [Security.SecurityElement]::Escape($Title); $b = [Security.SecurityElement]::Escape($Body)
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml("<toast><visual><binding template=`"ToastGeneric`"><text>$t</text><text>$b</text></binding></visual></toast>")
        $app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show((New-Object Windows.UI.Notifications.ToastNotification $xml))
        return $true
    } catch { Write-Log "알림 표시 실패(요약 파일은 정상 저장됨): $($_.Exception.Message)"; return $false }
}

# 복구는 "대화"만 되돌린다. 세션 안에서 켜 둔 감시(Monitor)·예약(ScheduleWakeup)은 프로그램이 꺼질 때 같이 사라져 되살아나지 않는다.
# 그래서 이번에 복구된 Claude 대화 중 "닫히기 직전에 감시·예약이 켜져 있던 것"을 대화 기록에서 찾아 알려 준다(scan-monitors.mjs, 읽기 전용).
# 알려 주기만 한다 - 다른 창에 입력을 보내 자동으로 다시 켜지 않는다. 어디서든 실패하면 조용히 건너뛰고(복구 결과에 영향 없음) 로그만 남긴다.
function Get-MonitorLoss($Rows) {
    $res = @()
    try {
        if ($null -eq $script:ShutdownAt) { return $res }
        $sids = @($Rows | Where-Object { $_.state -eq '성공' } | ForEach-Object { "$($script:SidByAddr[$_.addr])" } | Where-Object { $_ -match '^[0-9a-fA-F-]{36}$' } | Select-Object -Unique)
        $scan = Join-Path $Dir 'scan-monitors.mjs'
        $node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
        if ($sids.Count -eq 0 -or -not $node -or -not (Test-Path $scan)) { return $res }
        $t = [DateTimeOffset]::new([datetime]$script:ShutdownAt).ToUnixTimeMilliseconds()
        $out = Join-Path $env:TEMP ('keeper-mon-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
        $argLine = "`"$scan`" $t --json --sids $($sids -join ',')"
        $p = Start-Process -FilePath $node -ArgumentList $argLine -WindowStyle Hidden -PassThru -RedirectStandardOutput $out
        if (-not $p.WaitForExit(40000)) { try { $p.Kill() } catch {}; Write-Log '감시·예약 확인이 40초 안에 끝나지 않아 건너뜁니다.'; Remove-TempFile $out; return $res }
        $j = ([IO.File]::ReadAllText($out, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json); Remove-TempFile $out
        $res = @($j.rows | Where-Object { [int]$_.monAtT -gt 0 -or [int]$_.wakeAtT -gt 0 })
    } catch { Write-Log "감시·예약 확인을 건너뜁니다: $($_.Exception.Message)"; $res = @() }
    return $res
}

function Write-RestoreSummary([bool]$Notify) {
    $rows = @($script:Outcome.Values | Sort-Object { $_.addr })
    $monLoss = @(Get-MonitorLoss $rows)
    $cnt = @{ '성공' = 0; '실패' = 0; '건너뜀' = 0; '대기' = 0 }
    foreach ($r in $rows) { $cnt[$r.state]++ }
    $benign = @($rows | Where-Object { $_.state -eq '건너뜀' -and $_.detail -like '*이미 실행 중*' }).Count
    $need = $cnt['실패'] + $cnt['대기'] + ($cnt['건너뜀'] - $benign)
    $boot = Get-BootId
    $fresh = (((Get-Date) - [datetime]$boot).TotalMinutes -lt 20)
    if ($rows.Count -eq 0) { $verdict = $(if ($fresh) { '확인 필요 - 재부팅 직후인데 복구할 기록이 없습니다(기록이 비어 있었을 수 있음)' } else { '복구할 것 없음' }) }
    elseif ($need -eq 0) { $verdict = '정상 - 전부 복구됨(또는 이미 실행 중)' }
    else { $verdict = "주의 - 확인이 필요한 창 $need 개" }
    # 대화가 복구돼도 세션 안의 감시·예약은 되살아나지 않으므로, 켜져 있던 창이 있으면 판정을 "정상"으로 두지 않는다
    if ($monLoss.Count -gt 0) {
        if ($rows.Count -gt 0 -and $need -eq 0) { $verdict = "주의 - 대화는 전부 복구됨 · 감시·예약 재가동 필요 $($monLoss.Count) 개" }
        elseif ($rows.Count -gt 0) { $verdict += " · 감시·예약 재가동 필요 $($monLoss.Count) 개" }
    }
    $L = @('세션 자동 복구 결과')
    $L += ('작성: {0:yyyy-MM-dd HH:mm:ss} / 부팅: {1} / 복구 창 시작: {2}' -f (Get-Date), $boot, $script:WinOpenAt)
    $L += "판정: $verdict"
    $L += "집계: 대상 $($rows.Count)개 = 성공 $($cnt['성공']) / 실패 $($cnt['실패']) / 건너뜀 $($cnt['건너뜀']) (그중 이미 실행 중 $benign) / 시간 안에 못 끝낸 것 $($cnt['대기'])"
    $L += "직전 종료: $($script:PrevInfo)"
    if ($script:RecentInfo -and $script:RecentInfo.excluded -gt 0) { $L += "자동 복구 범위: 닫히기 직전에 열려 있던 창 $($script:RecentInfo.target)개만 자동 복구, 그 전에 닫힌 옛 항목 $($script:RecentInfo.excluded)개는 제외(Herdr 복구 목록의 [복구]로 직접 되살릴 수 있음)" }
    if ($monLoss.Count -gt 0) {
        $L += "감시·예약 재가동 필요 $($monLoss.Count)개: 대화는 복구됐지만 그 세션 안에서 켜 두었던 감시(Monitor)·예약은 되살아나지 않습니다. 해당 창에서 다시 켜 주세요(자동으로 켜지 않습니다)."
        foreach ($m in $monLoss) { $d = @($m.desc | Where-Object { $_ }) -join ' | '; $L += ('  {0,-5} {1}  - 감시 {2}개 / 예약 {3}개{4}' -f $m.addr, $m.where, [int]$m.monAtT, [int]$m.wakeAtT, $(if ($d) { " ($d)" } else { '' })) }
        Write-Log ("감시·예약 재가동 필요 {0}개: {1}" -f $monLoss.Count, (($monLoss | ForEach-Object { "$($_.addr) [$($_.where)]" }) -join ', '))
    }
    $L += ''
    foreach ($st in '실패', '대기', '건너뜀', '성공') {
        $g = @($rows | Where-Object { $_.state -eq $st })
        if ($g.Count -gt 0) {
            $L += "[$st] $($g.Count)개"
            foreach ($r in $g) {
                $s8 = $(if ($script:SidByAddr.ContainsKey($r.addr)) { "$($script:SidByAddr[$r.addr])".Substring(0, [Math]::Min(8, "$($script:SidByAddr[$r.addr])".Length)) } else { '' })
                $L += ('  {0,-5} {1}  - {2} ({3}) [{4}]' -f $r.addr, $r.where, $r.detail, $r.at, $s8)
            }
            $L += ''
        }
    }
    if ($need -gt 0 -or ($rows.Count -eq 0 -and $fresh)) { $L += '다음 할 일: Herdr 의 "AI 세션 목록 · 복구" 창 > "꺼진 세션" 에서 해당 세션을 골라 [복구] 를 누르세요. 자세한 기록은 session-keeper.log 에 있습니다.' }
    if ($rows.Count -gt 0) { $L += '참고: 다시 열릴 필요가 없는 작업은 session-keeper.ps1 -Mode Forget -Sid <[ ] 안의 8자> 로 목록에서 뺄 수 있습니다.' }
    $text = ($L -join "`r`n") + "`r`n"
    try {
        [IO.File]::WriteAllText($SummaryFile, $text, (New-Object Text.UTF8Encoding($true)))
        if ((Test-Path $HistoryFile) -and (Get-Item $HistoryFile).Length -gt 256KB) { Move-Item $HistoryFile ($HistoryFile + '.old') -Force }
        Add-Content -Path $HistoryFile -Value ($text + '----------------------------------------') -Encoding UTF8
    } catch { Write-Log "요약 파일 저장 실패: $($_.Exception.Message)" }
    Write-Log "복구 요약 저장: 판정=$verdict / 성공 $($cnt['성공']) 실패 $($cnt['실패']) 건너뜀 $($cnt['건너뜀']) 대기 $($cnt['대기'])"
    if ($Notify -and ($rows.Count -gt 0 -or $fresh)) {
        if ($rows.Count -eq 0) { $null = Show-Toast 'Herdr 세션 복구: 기록 없음' '재부팅 직후인데 복구할 기록이 없습니다. LAST-RESTORE.txt 를 확인하세요.' }
        elseif ($need -eq 0 -and $monLoss.Count -gt 0) { $null = Show-Toast 'Herdr 세션 복구: 감시 재가동 필요' "대화는 복구됨($($cnt['성공'])개). 감시·예약 $($monLoss.Count)개는 직접 다시 켜야 합니다 - LAST-RESTORE.txt 참고" }
        elseif ($need -eq 0) { $null = Show-Toast 'Herdr 세션 복구 완료' "성공 $($cnt['성공'])개 (이미 실행 중 $benign개)" }
        else { $null = Show-Toast 'Herdr 세션 복구: 확인 필요' "성공 $($cnt['성공'])개 / 확인 필요 $need개 - LAST-RESTORE.txt 를 보세요." }
    }
}

# 복구 1라운드. 반환: pending / acted / retry / skipped
# 복구 라운드는 한 번에 하나만: 자동 감시와 수동 실행(-Mode Recover)이 동시에 같은 창에 입력하면
# 명령이 2번 들어가는 것이 실제로 재현되어(3회 중 1회) 잠금으로 막는다.
function Invoke-Recover([bool]$AllowCreate) {
    $mx = New-Object Threading.Mutex($false, 'Local\HerdrSessionKeeperRecover')
    $got = $false
    try { $got = $mx.WaitOne(180000) } catch [Threading.AbandonedMutexException] { $got = $true }   # 잠근 쪽이 죽었으면 이어받는다
    if (-not $got) { Write-Log '다른 복구가 3분 넘게 진행 중이라 이번 라운드는 건너뜁니다.'; return @{ pending = 0; acted = 0; retry = 1; skipped = 0 } }
    try { return (Invoke-RecoverCore $AllowCreate) } finally { $mx.ReleaseMutex() }
}

# 복구 순서: restore-priority.txt 에 적은 공간 이름 순서(목록에 없으면 맨 뒤) -> 최근에 쓴 대화 먼저 -> 창 주소.
# (예전에는 창 주소 글자순이라 프로젝트 창이 뒤로 밀렸다 - 실제 재부팅에서 프로젝트 창이 시작 후 4~7분 뒤에야 복구됨)
$PriorityFile = Join-Path $Dir 'restore-priority.txt'
function Get-PriorityList {
    try { if (Test-Path -LiteralPath $PriorityFile) { return @(Get-Content -LiteralPath $PriorityFile -Encoding UTF8 | ForEach-Object { "$_".Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') }) } } catch {}
    return @()
}
function Get-EntrySpace($e) {
    $s = "$(Get-Prop $e 'space' '')"
    if (-not $s -and "$($e.where)" -match ' / ') { $s = ("$($e.where)" -split ' / ', 2)[0] }
    return $s
}
function Get-EntryRecency($e) {
    try {
        $f = $null
        if ("$(Get-Prop $e 'tool' 'claude')" -eq 'codex') { $f = "$(Get-Prop $e 'file' '')" }
        elseif ("$($e.cwd)") { $f = Join-Path $ProjDir ((("$($e.cwd)") -replace '[^A-Za-z0-9]', '-') + "\$($e.sid).jsonl") }
        if ($f -and (Test-Path -LiteralPath $f)) { return (Get-Item -LiteralPath $f).LastWriteTimeUtc.Ticks }
    } catch {}
    return [long]0
}
function Sort-RecoverOrder($Entries) {
    $list = @($Entries | Where-Object { $null -ne $_ })      # $null 하나가 들어와도 빈 목록으로 본다
    if ($list.Count -eq 0) { return @() }
    $prio = @(Get-PriorityList)
    $rows = @(foreach ($e in $list) { $idx = [array]::IndexOf($prio, (Get-EntrySpace $e)); [pscustomobject]@{ e = $e; rank = $(if ($idx -ge 0) { $idx } else { 999 }); rec = (Get-EntryRecency $e); addr = "$($e.addr)" } })
    return @($rows | Sort-Object @{ Expression = 'rank'; Ascending = $true }, @{ Expression = 'rec'; Descending = $true }, @{ Expression = 'addr'; Ascending = $true } | ForEach-Object { $_.e })
}

# "닫히기 직전" 기준 시각: 대기 기록들이 마지막으로 확인된(seen) 시각 중 가장 늦은 것에서 $Min 분 앞. 읽을 수 있는 시각이 없으면 $null.
# 열려 있던 창은 키퍼가 계속 seen 을 갱신하므로, 닫히는 순간 열려 있던 창들은 모두 이 시각 근처이고 예전에 닫힌 창은 한참 앞선다.
function Get-RecentCutoff($Pending, [int]$Min) {
    $max = $null
    foreach ($e in @($Pending)) { try { $d = [datetime](Get-Prop $e 'seen' ''); if ($null -eq $max -or $d -gt $max) { $max = $d } } catch {} }
    if ($null -eq $max) { return $null }
    return $max.AddMinutes(-$Min)
}
# 기준 시각 이후에 확인된 창이면 $true. seen 을 읽을 수 없으면 빠뜨리지 않도록 $true.
function Test-RecentEntry($E, $Cutoff) {
    if ($null -eq $Cutoff) { return $true }
    try { return ([datetime](Get-Prop $E 'seen' '') -ge $Cutoff) } catch { return $true }
}

function Invoke-RecoverCore([bool]$AllowCreate) {
    $boot = Get-BootId
    $map = Read-Map
    $pending = @(Sort-RecoverOrder @($map.Values | Where-Object { $_.boot -ne $boot -or (Get-Prop $_ 'orphan' $false) }))
    if ($Only) { $pending = @($pending | Where-Object { $_.addr -eq $Only }) }
    # 자동 복구(Run)에만 적용한다. 사용자가 직접 누르는 [전부 복구]·[미리보기](-Mode Recover)는 목록 전체를 대상으로 한다.
    elseif ($script:AutoScope -and $RecentMin -gt 0 -and $pending.Count -gt 0) {
        # 기준 시각은 앱이 새로 켜진 사건(복구 시작)마다 처음 한 번만 정한다(복구가 진행돼 대기 목록이 줄어도 기준이 옛날로 밀려나지 않게).
        $first = ($null -eq $script:RecentInfo)
        if ($null -eq $script:RecentCutoff) { $script:RecentCutoff = Get-RecentCutoff $pending $RecentMin }
        $recent = @($pending | Where-Object { Test-RecentEntry $_ $script:RecentCutoff })
        if ($first) {
            $script:RecentInfo = @{ target = $recent.Count; excluded = ($pending.Count - $recent.Count) }
            if ($script:RecentCutoff) { $script:ShutdownAt = ([datetime]$script:RecentCutoff).AddMinutes($RecentMin) }   # 닫히기 직전 시각(감시·예약 확인 기준)
            # 복구 목록 창이 "자동 복구 대상/제외"를 키퍼와 똑같이 보여 주도록 기준 시각을 파일로 남긴다(실패해도 복구에는 영향 없음)
            if ($script:RecentCutoff) { try { [IO.File]::WriteAllText($CutoffFile, ([datetime]$script:RecentCutoff).ToString('yyyy-MM-ddTHH:mm:ss')) } catch {} }
            if ($recent.Count -lt $pending.Count) {
                Write-Log ("닫히기 직전({0:MM-dd HH:mm} 이후)에 열려 있던 창만 복구합니다: 대상 {1} / 제외 {2} (그 전에 닫힌 창 - 복구 목록에는 남아 있어 직접 복구할 수 있음)" -f $script:RecentCutoff, $recent.Count, ($pending.Count - $recent.Count))
            }
        }
        $pending = $recent
    }
    foreach ($e in $pending) { $script:SidByAddr[$e.addr] = "$($e.sid)" }
    $res = @{ pending = $pending.Count; acted = 0; retry = 0; skipped = 0 }
    if ($pending.Count -eq 0) { return $res }
    $actions = @()
    foreach ($e in $pending) {
        $d = Get-EntryDecision $e $AllowCreate
        Write-Log ('{0} {1,-5} {2,-30} {3}  -> {4}' -f $d.Action, $e.addr, "$($e.where)", "$($e.sid)".Substring(0, [Math]::Min(8, "$($e.sid)".Length)), $d.Reason)
        if ($d.Action -eq 'SKIP') {
            if ($d.Retry) { $res.retry++; Set-Outcome $e.addr "$($e.where)" '대기' $d.Reason }
            else {
                $res.skipped++
                $st = if ($d.Reason -like '시도*초과') { '실패' } else { '건너뜀' }
                Set-Outcome $e.addr "$($e.where)" $st $d.Reason
            }
        }
        else { $actions += , @($e, $d.Action) }
    }
    Write-Log "복구 라운드: 대기 $($pending.Count) / 실행 예정 $($actions.Count) / 나중에 재시도 $($res.retry) / 건너뜀 $($res.skipped)  (모드: $(if ($Plan) { '미리보기' } else { '실제' }))"
    if ($Plan -or $actions.Count -eq 0) { $res.acted = 0; return $res }
    for ($i = 0; $i -lt $actions.Count; $i += $Batch) {
        $chunk = $actions[$i..([Math]::Min($i + $Batch, $actions.Count) - 1)]
        $waiting = @()      # 입력을 보냈고 실행 확인을 기다리는 빈 셸 창들 - 묶음 안에서 한꺼번에 확인한다
        $howOf = @{}
        foreach ($a in $chunk) {
            $e = $a[0]
            $again = Get-EntryDecision $e $AllowCreate          # 실행 직전에 한 번 더 확인
            if ($again.Action -eq 'SKIP') {
                Write-Log "$($e.addr) 직전 재확인에서 건너뜀: $($again.Reason)"
                Set-Outcome $e.addr "$($e.where)" $(if ($again.Retry) { '대기' } else { '건너뜀' }) $again.Reason
                continue
            }
            $how = if ($again.Action -eq 'TYPE') { '빈 셸에 입력' } else { '새 탭으로 생성' }
            if ("$(Get-Prop $e 'tool' 'claude')" -eq 'codex') { $how += ' (Codex)' }
            $howOf[$e.addr] = $how
            if ($again.Action -eq 'TYPE') {
                $s = Send-ResumeInput $e
                $res.acted++
                if ($s -eq 'SENT') { $waiting += , $e }
                else { Set-Outcome $e.addr "$($e.where)" '대기' "$s - 다음 라운드에 재시도"; $res.retry++ }
            } else {
                $r = New-ResumeTab $e $boot
                $res.acted++
                switch ($r) {
                    'OK'        { Set-Outcome $e.addr "$($e.where)" '성공' $how }
                    'NOT-FOUND' { Set-Outcome $e.addr "$($e.where)" '실패' '대화를 찾지 못함' }
                    'TIMEOUT'   { Set-Outcome $e.addr "$($e.where)" '실패' '60초 안에 실행이 확인되지 않음(화면 확인 필요)' }
                    default     { Set-Outcome $e.addr "$($e.where)" '대기' "$r - 다음 라운드에 재시도" }
                }
                if ($r -in @('NO-APP', 'ERR', 'SEND-FAIL')) { $res.retry++ }
            }
        }
        if ($waiting.Count -gt 0) {
            $w = Wait-ClaudeUpMany $waiting
            foreach ($e in $waiting) {
                $r = Complete-Resume $e $w[$e.addr] $boot
                switch ($r) {
                    'OK'        { Set-Outcome $e.addr "$($e.where)" '성공' $howOf[$e.addr] }
                    'NOT-FOUND' { Set-Outcome $e.addr "$($e.where)" '실패' '대화를 찾지 못함' }
                    'TIMEOUT'   { Set-Outcome $e.addr "$($e.where)" '실패' '60초 안에 실행이 확인되지 않음(화면 확인 필요)' }
                }
            }
        }
        if (($i + $Batch) -lt $actions.Count) { Start-Sleep -Seconds $DelaySec }   # PC 부담 줄이기(실측상 여유가 커서 짧게)
    }
    return $res
}

# ---------------------------------------------------------------- Run (로그온용 상주)
# herdr-core(serve) 가 켜진 지 몇 초 되었는지. 못 찾으면 0(= 아직 기다림).
function Get-CoreAgeSec {
    try {
        $c = Get-CimInstance Win32_Process -Filter "Name='herdr-core.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match '\sserve(\s|$)' } | Sort-Object CreationDate | Select-Object -First 1
        if ($c) { return [math]::Max(0, ((Get-Date) - $c.CreationDate).TotalSeconds) }
    } catch {}
    return -1     # 못 찾음(0 초와 구분한다: 못 찾은 채로 영영 기다리지 않도록 Test-AllowCreate 가 따로 다룬다)
}

# 새 탭 생성을 허용할지. 코어가 켜진 지 MinWait 초가 지났으면 허용(재부팅 직후 되살아나는 창과 겹치지 않게).
# 코어 시작 시각을 못 찾으면(-1) 영영 막히지 않도록, 복구 창이 열린 지 MinWait 초가 지났을 때 허용한다.
# (2026-11-09: t12r Codex 창이 복구 창 10분 내내 "코어 유예" 로 건너뛰어졌다 -> 시간 초과)
function Test-AllowCreate([double]$CoreAge, [double]$ElapsedSec, [int]$MinWait) {
    if ($CoreAge -ge $MinWait) { return $true }
    if ($CoreAge -lt 0 -and $ElapsedSec -ge $MinWait) { return $true }
    return $false
}

# 심박: 감시가 살아 있는 동안 pid|시각|부팅 을 적어 둔다. 다음 시작 때 같은 부팅인데 그 pid 가 없으면
# "정상 종료 없이 갑자기 사라졌다"는 뜻이므로 로그에 경고를 남긴다(이전에 조용히 사라진 일이 있었음).
$AliveFile = Join-Path $Dir 'session-keeper.alive'
function Set-Heartbeat { try { [IO.File]::WriteAllText($AliveFile, "$PID|$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')|$(Get-BootId)") } catch {} }
$script:PrevHb = $null
# 감시가 막 켜졌을 때 Herdr 앱이 "이미 떠 있던 것"인지: 같은 부팅이고 앱이 직전 감시의 마지막 심박보다 먼저 켜졌으면 true
function Test-AppAlreadyUp($App, $PrevHb, [string]$BootNow) {
    return [bool]($App -and $PrevHb -and $PrevHb.boot -eq $BootNow -and $App.StartTime -lt $PrevHb.time)
}
function Test-PreviousRunDied {
    try {
        if (-not (Test-Path $AliveFile)) { return }
        $p = ([IO.File]::ReadAllText($AliveFile)).Trim() -split '\|'
        if ($p.Count -ge 3) { $script:PrevHb = @{ time = [datetime]$p[1]; boot = $p[2] } }   # 직전 감시의 마지막 심박(앱이 새로 켜졌는지 판단에 사용)
        if ($p.Count -ge 3 -and $p[2] -eq (Get-BootId) -and -not (Get-Process -Id ([int]$p[0]) -ErrorAction SilentlyContinue)) {
            Write-Log "경고: 같은 부팅 안에서 이전 감시(pid $($p[0]))가 $($p[1]) 이후 정상 종료 표시 없이 갑자기 사라졌습니다."
        }
    } catch {}
}

function Invoke-Run {
    $mutex = New-Object Threading.Mutex($false, 'Local\HerdrSessionKeeper')
    # 이미 실행 중이면 조용히 종료(감시 장치가 5분마다 호출하므로 로그를 쌓지 않는다)
    if (-not $mutex.WaitOne(0)) { Write-Host '이미 실행 중입니다.'; return }
    try {
        $script:AutoScope = $true   # 이 실행이 하는 복구는 "자동 복구"(닫히기 직전 창만)
        Test-PreviousRunDied
        Set-Heartbeat
        Write-Log "== session-keeper 시작 (부팅 $(Get-BootId), pid $PID)"
        # 2026-11-09: Herdr 앱을 이 스크립트가 직접 켜지 않는다. PC 부팅만으로는 켜지 않고, 사용자가 Herdr 를 켰을 때
        # 감시 작업(session-keeper-watchdog.vbs, 1분 간격)이 이 스크립트를 시작한다. 앱이 없으면 아래 '앱 종료 대기' 규칙으로 곧 끝난다.
        if (-not (Get-Process $AppProc -ErrorAction SilentlyContinue)) { Write-Log 'Herdr 앱이 꺼져 있습니다. 앱이 켜지면 복구를 시작하고, 앱이 계속 꺼져 있으면 곧 종료합니다.' }
        $ready = $false
        for ($i = 0; $i -lt 36; $i++) { if (Invoke-HcJson @('ls')) { $ready = $true; break }; Start-Sleep -Seconds 5 }
        if (-not $ready) { Write-Log '코어가 3분 안에 준비되지 않았습니다. 앱이 켜지면 복구를 시작합니다.' }
        $all = Invoke-HcJson @('ls', '--all')
        if ($all) {
            $c = @($all.terminals | Group-Object state | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ' '
            $pend = @((Read-Map).Values | Where-Object { $_.boot -ne (Get-BootId) -or (Get-Prop $_ 'orphan' $false) }).Count
            Write-Log "시작 상태: 코어 창 [$c] / 복구 대기 기록 $pend 개"
        }
        $appWasUp = $false; $active = $false; $trigger = Get-Date; $quiet = 0
        # 감시만 다시 켜진 경우(같은 부팅이고 앱이 직전 심박보다 먼저 떠 있었음)는 "앱이 새로 켜진 것"이 아니므로
        # 복구를 시작하지 않는다 -> 방금 일부러 닫은 탭이 되살아나지 않게. 앱이 감시 공백 중에 새로 켜졌으면 시작한다.
        $curApp = Get-Process $AppProc -ErrorAction SilentlyContinue | Select-Object -First 1
        $appWasUp = Test-AppAlreadyUp $curApp $script:PrevHb (Get-BootId)
        $nextRecover = Get-Date; $nextSnap = Get-Date; $nextAppUpd = (Get-Date).AddMinutes(1)
        $appGoneSince = $null   # 앱이 꺼진 것을 처음 본 시각(앱이 AppGoneExitSec 넘게 꺼져 있으면 이 감시도 끝낸다)
        while ($true) {
          try {
            $now = Get-Date
            $appUp = [bool](Get-Process $AppProc -ErrorAction SilentlyContinue)
            if ($appUp) { $appGoneSince = $null; $script:AppRelaunchTried = $false }
            elseif (-not $appGoneSince) { $appGoneSince = $now }
            elseif (($now - $appGoneSince).TotalSeconds -ge $AppGoneExitSec) {
                Write-Log "Herdr 앱이 $AppGoneExitSec 초 넘게 꺼져 있어 session-keeper 를 종료합니다. 앱을 다시 켜면 감시 작업이 자동으로 다시 시작합니다."
                break
            }
            if ($appUp -and -not $appWasUp -and (Test-AppUpdateInProgress)) {
                # 업데이트 때문에 앱을 일부러 껐다 켠 것: 사고가 아니므로 복구 창을 열지 않는다(터미널은 코어에 그대로 살아 있다)
                Write-Log '앱 업데이트로 창을 다시 켠 것을 확인했습니다. 복구 창은 열지 않습니다.'
            }
            elseif ($appUp -and -not $appWasUp) {
                $trigger = $now; $active = $true; $quiet = 0; $nextRecover = $now.AddSeconds(20)
                $script:Outcome = @{}; $script:WinOpenAt = $now.ToString('HH:mm:ss'); $script:PrevInfo = Get-PreviousShutdownInfo
                $script:RecentCutoff = $null; $script:RecentInfo = $null; $script:ShutdownAt = $null   # 새 사건: "닫히기 직전" 기준을 다시 정한다
                Write-Log "Herdr 앱 시작 감지 -> $WindowMin 분 동안 $RoundSec 초 간격으로 복구를 시도합니다."
                Write-Log "직전 종료: $($script:PrevInfo)"
                # 방금 켜진 Herdr 가 옛 버전이고 새 버전이 받아져 있으면 곧바로 적용(자동 업데이트가 꺼져 있으면 건너뜀). 창이 다시 뜨면 그 새 창은 "새 사건"으로 세지 않는다.
                $freshApp = Get-Process $AppProc -ErrorAction SilentlyContinue | Sort-Object StartTime -Descending | Select-Object -First 1
                if (Invoke-AppUpdateOnStart $freshApp) { $nextRecover = (Get-Date).AddSeconds(20) }
            }
            $appWasUp = $appUp
            if ($active -and $appUp -and $now -ge $nextRecover) {
                $elapsed = ($now - $trigger).TotalSeconds
                # 새 탭 생성은 "코어가 켜진 지" 기준으로 기다린다(재부팅 직후엔 코어 유예 시간을 지키고,
                # 앱만 다시 켠 경우처럼 코어가 이미 오래 떠 있으면 기다리지 않고 바로 복구한다).
                $coreAge = Get-CoreAgeSec
                $allow = Test-AllowCreate $coreAge $elapsed $MinWaitSec
                if (-not $allow) { Write-Log "새 탭 생성 대기: 코어 시작 후 $([int]$coreAge)초(기준 ${MinWaitSec}초, -1=시작 시각 못 찾음) / 복구 창 경과 $([int]$elapsed)초" }
                $res = Invoke-Recover $allow
                if ($res.pending -eq 0 -or ($res.acted -eq 0 -and $res.retry -eq 0)) { $quiet++ } else { $quiet = 0 }
                # 아직 "나중에 다시 볼" 항목이 남아 있으면 복구 창을 최대 3배(기본 30분)까지 늘린다(10분에 못 끝난 항목이 그대로 방치되던 문제)
                $limitSec = $WindowMin * 60; if ($res.retry -gt 0) { $limitSec = $WindowMin * 60 * 3 }
                if ($quiet -ge 3 -or $elapsed -ge $limitSec) {
                    $active = $false
                    Write-Log "복구 창 닫힘 (경과 $([int]$elapsed)초, 조용한 라운드 $quiet). 남은 대기 기록은 session-map.json 에 보존."
                    Write-RestoreSummary $true
                }
                $nextRecover = (Get-Date).AddSeconds($RoundSec)
            }
            if (-not $appUp -and $appGoneSince -and ($now - $appGoneSince).TotalSeconds -ge 20 -and ((Get-AppUpdateMarker) -eq 'run') -and -not (Get-Process -Id (Get-AppUpdateMarkerPid) -ErrorAction SilentlyContinue) -and -not $script:AppRelaunchTried) {
                # 업데이트가 창을 끈 뒤 중간에 멈췄다(예: 업데이트 프로세스가 창과 함께 종료됨). 이 감시는 창과 별개라 대신 앱을 켠다. 터미널은 코어에 그대로 있다.
                $script:AppRelaunchTried = $true
                Write-Log '앱 업데이트 재시작 중 새 창이 20초 넘게 뜨지 않아 세션키퍼가 대신 앱을 켭니다.'
                try { if (@(Get-AppProcs (Get-AppInstallDir)).Count -eq 0) { Start-AppWindow (Join-Path (Get-AppInstallDir) 'herdr-app.exe') } } catch { Write-Log "대신 켜기 실패: $($_.Exception.Message)" }
            }
            if ($now -ge $nextSnap -and -not ((Test-AppUpdateBusy) -and (Get-Process -Id (Get-AppUpdateMarkerPid) -ErrorAction SilentlyContinue))) { Invoke-Snapshot; Set-Heartbeat; $nextSnap = (Get-Date).AddSeconds($LoopSec) }
            elseif ($now -ge $nextSnap) { Set-Heartbeat; $nextSnap = (Get-Date).AddSeconds(10) }   # 앱을 껐다 켜는 동안엔 기록을 건너뛴다(창 배치를 못 읽는 순간의 기록을 남기지 않게)
            if ($now -ge $nextAppUpd -and -not $active) { $nextAppUpd = (Get-Date).AddMinutes(5); Invoke-AppUpdateTick }
          } catch {
            # 한 번의 오류로 감시 전체가 죽지 않게: 기록만 남기고 계속 진행
            Write-Log "루프 오류(계속 진행): $($_.Exception.Message)"
          }
            Start-Sleep -Seconds 5
        }
    } finally { Remove-TempFile $AliveFile; $mutex.ReleaseMutex() }   # 정상 종료면 심박 파일 제거(=정상 종료 표시)
}

# 영영 끝낸 작업을 복구 목록에서 뺀다. 탭을 닫은 작업도 다시 열리게 해 두었기 때문에, 더는 필요 없는 작업은 이렇게 정리한다.
# "닫히기 직전"이 아니어서 자동 복구에서 빠지는 옛 대기 항목을 한꺼번에 목록에서 뺀다(Herdr 복구 목록의 [옛 항목 N개 제외] 버튼).
# 대상은 화면의 "직접 복구" 항목과 같은 기준(기준 시각 파일 -> 없으면 대기 기록으로 계산). 대화 기록(.jsonl)은 지우지 않는다.
# 지우기 전에 session-map.json.before-forget-old-<시각> 백업을 남기고 최근 5개만 보관한다. 감시가 동시에 지도를 다시 쓸 수 있어 4초 뒤 같은 항목만 한 번 더 확인한다.
function Invoke-ForgetOld {
    $boot = Get-BootId
    $removed = @{}
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    for ($round = 1; $round -le 2; $round++) {
        $map = Read-Map
        $pending = @($map.Values | Where-Object { "$($_.sid)" -and ($_.boot -ne $boot -or (Get-Prop $_ 'orphan' $false)) })
        $cut = $null
        if (Test-Path $CutoffFile) { try { $cut = [datetime]([IO.File]::ReadAllText($CutoffFile).Trim()) } catch { $cut = $null } }
        if ($null -eq $cut) { $cut = Get-RecentCutoff $pending $RecentMin }
        $old = @($pending | Where-Object { -not (Test-RecentEntry $_ $cut) })
        if ($round -eq 2) { $old = @($old | Where-Object { $removed.ContainsKey("$($_.sid)") }) }
        if ($old.Count -eq 0) { if ($round -eq 1) { Write-Host '제외할 옛 항목이 없습니다.' }; break }
        if ($round -eq 1) {
            $bak = "$MapFile.before-forget-old-$stamp"
            try { Copy-Item $MapFile $bak -Force } catch { Write-Host "백업을 만들지 못해 중단합니다: $($_.Exception.Message)"; exit 1 }
            try { Get-ChildItem "$MapFile.before-forget-old-*" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip 5 | Remove-Item -Force -ErrorAction SilentlyContinue } catch {}
        }
        foreach ($e in $old) {
            $k = "$($e.addr)"; if (-not $map.ContainsKey($k)) { continue }
            $removed["$($e.sid)"] = $true
            Write-Log "복구 목록에서 뺌(옛 항목 일괄): $k [$($e.where)] sid $($e.sid)"
            $map.Remove($k)
        }
        Save-Map $map
        if ($round -eq 1) { Start-Sleep -Seconds 4 }
    }
    if ($removed.Count -gt 0) { Write-Host "옛 항목 $($removed.Count)개를 복구 목록에서 뺐습니다. 백업: $MapFile.before-forget-old-$stamp" }
}

function Invoke-Forget {
    if ($Stale) { Invoke-ForgetOld; return }
    if ($Sid -notmatch '^[0-9a-f-]{6,36}$') { Write-Host '-Sid 에 세션ID 앞 6자 이상을 적어 주세요(소문자/숫자/-). 예: -Mode Forget -Sid 69fc0b67  (LAST-RESTORE.txt 의 [ ] 안 8자)'; return }
    for ($round = 1; $round -le 2; $round++) {      # 감시가 동시에 지도를 다시 쓸 수 있어, 4초 뒤 한 번 더 확인
        $map = Read-Map
        $hit = @($map.Keys | Where-Object { "$($map[$_].sid)" -like "$Sid*" })
        if ($hit.Count -eq 0) { if ($round -eq 1) { Write-Host '일치하는 기록이 없습니다.' }; return }
        foreach ($k in $hit) { Write-Log "복구 목록에서 뺌: $k [$($map[$k].where)] sid $("$($map[$k].sid)".Substring(0, 8))"; $map.Remove($k) }
        Save-Map $map
        if ($round -eq 1) { Start-Sleep -Seconds 4 }
    }
}

if (-not $env:KEEPER_NO_MAIN) {
    switch ($Mode) {
        'Snapshot' { Invoke-Snapshot; Write-Log "기록 완료: $MapFile" }
        'Forget'   { Invoke-Forget }
        'Update'   {
            if ($Auto) { Set-AppAutoUpdate $Auto; exit 0 }
            if ($Launcher -eq 'Install') { exit (Install-HerdrLauncher) }
            if ($Launcher -eq 'Uninstall') { exit (Uninstall-HerdrLauncher) }
            if ($Launcher -eq 'Status') { Show-HerdrLauncher; exit 0 }
            exit (Invoke-AppUpdate ([bool]$Plan) (-not $NoRestart))
        }
        'Recover'  {
            $script:Outcome = @{}; $script:WinOpenAt = (Get-Date).ToString('HH:mm:ss'); $script:PrevInfo = Get-PreviousShutdownInfo
            $null = Invoke-Recover $true
            if (-not $Plan) { Write-RestoreSummary $false }   # 미리보기(-Plan)는 진짜 결과 파일을 덮어쓰지 않는다
        }
        'Run'      { Invoke-Run }
    }
}
