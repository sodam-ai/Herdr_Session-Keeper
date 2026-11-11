# install.ps1 - 세션키퍼 설치 (Herdr 모드 + 감시 프로그램 + 자동 실행 작업). 관리자 권한 필요 없음(현재 사용자에게만 설치).
#
#   설치/업데이트:  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
#   점검만(아무것도 바꾸지 않음):  ... -File install.ps1 -Check
#   제거:  ... -File uninstall.ps1
#
# 이 PC 환경이 달라도 되도록: node/Herdr 앱/hc/Herdr 설정 폴더/Claude 설정 폴더를 자동으로 찾아 kit.env 에 적어 둡니다.
# 다른 곳에 이미 설치된 세션키퍼가 있으면(작업 이름·모드가 다른 경로를 가리키면) 덮어쓰지 않고 멈춥니다(-Force 로만 교체).
param(
    [string]$InstallDir = '',      # 프로그램 설치 위치 (기본 %LOCALAPPDATA%\HerdrSessionKeeper\app)
    [string]$HerdrHome = '',       # Herdr 설정 폴더 (기본: HERDR_APP_HOME 또는 ~\.config\herdr-app)
    [string]$HerdrApp = '',        # herdr-app.exe 경로 (기본: 자동 탐색)
    [string]$TaskName = 'HerdrSessionKeeper-Watchdog',
    [switch]$NoTask,               # 자동 실행 작업(1분마다 점검)을 만들지 않음
    [switch]$NoKey,                # Ctrl+Shift+R 키 연결을 하지 않음
    [switch]$Launcher,             # (선택) Herdr 바로가기를 런처에 연결: 앱이 켜지기 전에 업데이트 적용. 되돌리기: 키퍼의 -Mode Update -Launcher Uninstall
    [switch]$RestartKeeper,        # 이미 돌고 있는 키퍼를 끄고 새 코드로 다시 켠다(감시 작업이 1분 안에 켬)
    [switch]$Force,                # 다른 위치의 기존 설치를 이 설치로 교체
    [switch]$Check                 # 점검만
)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Payload = Join-Path $Here 'payload'
function Say([string]$m) { Write-Host $m }
function Fail([string]$m) { Write-Host ''; Write-Host "중단: $m" -ForegroundColor Red; exit 1 }
function Write-Utf8NoBom([string]$path, [string]$text) {
    $tmp = "$path.tmp-kit"
    [IO.File]::WriteAllBytes($tmp, (New-Object Text.UTF8Encoding($false)).GetBytes($text))
    Move-Item -LiteralPath $tmp -Destination $path -Force
}

# ---------- 1) 점검: 필요한 것이 이 PC 에 있는지 ----------
Say '== 1/6 환경 점검 =='
if (-not (Test-Path -LiteralPath (Join-Path $Payload 'session-keeper.ps1'))) { Fail "설치 파일(payload)이 없습니다: $Payload  (압축을 완전히 푼 폴더에서 실행하세요)" }
if ($env:OS -ne 'Windows_NT') { Fail 'Windows 에서만 동작합니다.' }

# node (18 이상)
$node = $null
$cands = @()
$g = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1; if ($g) { $cands += $g.Source }
foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe", "$env:NVM_SYMLINK\node.exe")) { if ($p -and (Test-Path -LiteralPath $p)) { $cands += $p } }
foreach ($c in $cands) {
    try { $v = (& $c --version 2>$null | Out-String).Trim(); if ($v -match '^v(\d+)\.' -and [int]$Matches[1] -ge 18) { $node = $c; $nodeVer = $v; break } } catch {}
}
if (-not $node) { Fail 'Node.js 18 이상이 필요한데 찾지 못했습니다. https://nodejs.org 에서 LTS 설치 파일을 받아 설치한 뒤, 새 터미널(또는 새 Claude Code 창)에서 다시 실행하세요.' }
Say "  node: $node ($nodeVer)"

# Herdr 앱
function Find-HerdrApp {
    $list = @()
    if ($HerdrApp) { $list += $HerdrApp }
    if ($env:KEEPER_APP_EXE) { $list += $env:KEEPER_APP_EXE }
    $list += (Join-Path $env:LOCALAPPDATA 'Programs\herdr-app\herdr-app.exe')
    $gc = Get-Command herdr-app -ErrorAction SilentlyContinue | Select-Object -First 1; if ($gc) { $list += $gc.Source }
    foreach ($rk in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
        try { Get-ItemProperty -Path $rk -ErrorAction SilentlyContinue | Where-Object { "$($_.DisplayName)" -match 'herdr' -and $_.InstallLocation } | ForEach-Object { $list += (Join-Path $_.InstallLocation 'herdr-app.exe') } } catch {}
    }
    foreach ($c in $list) { if ($c -and (Test-Path -LiteralPath $c)) { return (Resolve-Path -LiteralPath $c).Path } }
    return $null
}
$App = Find-HerdrApp
if (-not $App) { Fail 'Herdr 앱(herdr-app.exe)을 찾지 못했습니다. Herdr 를 먼저 설치·실행한 뒤 다시 하거나, -HerdrApp "경로\herdr-app.exe" 로 알려 주세요.' }
$AppVer = ''; try { $AppVer = (& $App --version 2>$null | Out-String).Trim() } catch {}
Say "  Herdr 앱: $App ($AppVer)"

# hc (herdr-core)
$hc = $null
$g = Get-Command hc -ErrorAction SilentlyContinue | Select-Object -First 1; if ($g) { $hc = $g.Source }
if (-not $hc) {
    foreach ($p in @((Join-Path (Split-Path -Parent (Split-Path -Parent $App)) 'herdr-core\hc.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\herdr-core\hc.exe'))) { if (Test-Path -LiteralPath $p) { $hc = $p; break } }
}
if ($hc) { Say "  hc: $hc" } else { Say '  경고: hc(herdr-core)를 찾지 못했습니다. 세션 목록·복구가 동작하려면 Herdr 코어가 필요합니다(설치는 계속합니다).' }

# Herdr 설정 폴더
if (-not $HerdrHome) { $HerdrHome = $(if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $env:USERPROFILE '.config\herdr-app' }) }
if (-not (Test-Path -LiteralPath $HerdrHome)) { Fail "Herdr 설정 폴더가 없습니다: $HerdrHome  (Herdr 앱을 한 번 실행한 뒤 다시 시도하거나, -HerdrHome 으로 알려 주세요)" }
Say "  Herdr 설정 폴더: $HerdrHome"
$ModDir = Join-Path $HerdrHome 'mods\session-keeper'
$KeysFile = Join-Path $HerdrHome 'keys.json'

# 설치 위치
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'HerdrSessionKeeper\app' }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$ToolPath = (Join-Path $InstallDir 'sessions.mjs') -replace '\\', '/'
Say "  설치 위치: $InstallDir"
if ($InstallDir -match '[^\x20-\x7e]') { Say '  참고: 설치 경로에 한글 등이 있습니다. 대부분 동작하지만 가능하면 영문 경로를 권장합니다.' }

# 다른 위치의 기존 설치와 충돌?
$conflict = @()
try {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) { $args0 = ($t.Actions | ForEach-Object { "$($_.Arguments)" }) -join ' '; if ($args0 -notlike "*$InstallDir*") { $conflict += "작업 '$TaskName' 이 다른 위치를 가리킵니다: $args0" } }
} catch {}
$mainJs = Join-Path $ModDir 'main.js'
if (Test-Path -LiteralPath $mainJs) {
    $m0 = [regex]::Match([IO.File]::ReadAllText($mainJs, [Text.Encoding]::UTF8), 'const TOOL = "([^"]*)";')
    if ($m0.Success -and $m0.Groups[1].Value -ne $ToolPath) { $conflict += "Herdr 모드가 다른 위치를 가리킵니다: $($m0.Groups[1].Value)" }
}
if ($conflict.Count -gt 0 -and -not $Force) {
    Say '  이미 다른 위치에 세션키퍼가 설치되어 있습니다:'
    $conflict | ForEach-Object { Say "    - $_" }
    Fail '덮어쓰지 않았습니다. 기존 것을 쓰시거나, 이 설치로 교체하려면 -Force 를 붙이세요(기존 작업·모드는 이 설치를 가리키도록 바뀝니다).'
}
if ($Check) { Say ''; Say '점검 완료: 설치할 수 있는 환경입니다(아무것도 바꾸지 않았습니다).'; exit 0 }

# ---------- 2) 프로그램 복사 ----------
Say '== 2/6 프로그램 복사 =='
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
if (Test-Path -LiteralPath (Join-Path $InstallDir 'session-keeper.ps1')) {       # 업데이트: 옛 프로그램 파일을 한 벌 백업(최근 3벌만 보관)
    $bk = Join-Path $InstallDir ('_backup\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $bk -Force | Out-Null
    foreach ($n in @('session-keeper.ps1', 'sessions.mjs', 'scan-monitors.mjs', 'session-keeper-watchdog.vbs', 'herdr-launch.ps1', 'herdr-launch.vbs')) { if (Test-Path -LiteralPath (Join-Path $InstallDir $n)) { Copy-Item -LiteralPath (Join-Path $InstallDir $n) -Destination $bk -Force } }
    if (Test-Path -LiteralPath (Join-Path $InstallDir 'lib')) { Copy-Item -LiteralPath (Join-Path $InstallDir 'lib') -Destination $bk -Recurse -Force }
    Get-ChildItem -LiteralPath (Join-Path $InstallDir '_backup') -Directory | Sort-Object Name -Descending | Select-Object -Skip 3 | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}
New-Item -ItemType Directory -Path (Join-Path $InstallDir 'lib') -Force | Out-Null
foreach ($n in @('session-keeper.ps1', 'sessions.mjs', 'scan-monitors.mjs', 'session-keeper-watchdog.vbs', 'herdr-launch.ps1', 'herdr-launch.vbs')) { Copy-Item -LiteralPath (Join-Path $Payload $n) -Destination (Join-Path $InstallDir $n) -Force }
Get-ChildItem -LiteralPath (Join-Path $Payload 'lib') -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $InstallDir 'lib') -Force }
if (Test-Path -LiteralPath (Join-Path $Payload 'README-program.md')) { Copy-Item -LiteralPath (Join-Path $Payload 'README-program.md') -Destination $InstallDir -Force }
# 환경 파일: 이 PC 에서 찾은 위치를 적어 둔다(작업 스케줄러·Herdr 안은 PATH 가 달라도 동작하게)
$env0 = @("NODE_DIR=$(Split-Path -Parent $node)")
if ($hc) { $env0 += "HC_DIR=$(Split-Path -Parent $hc)" }
if ($App -ne (Join-Path $env:LOCALAPPDATA 'Programs\herdr-app\herdr-app.exe')) { $env0 += "APP_EXE=$App" }
if ($HerdrHome -ne (Join-Path $env:USERPROFILE '.config\herdr-app')) { $env0 += "APP_HOME=$HerdrHome" }
if ($env:CLAUDE_CONFIG_DIR) { $env0 += "CLAUDE_CFG=$($env:CLAUDE_CONFIG_DIR)" }
Write-Utf8NoBom (Join-Path $InstallDir 'kit.env') (($env0 -join "`r`n") + "`r`n")
Say "  복사 완료. 환경 파일: kit.env ($($env0.Count)개 항목)"

# ---------- 3) Herdr 모드 ----------
Say '== 3/6 Herdr 모드 설치 =='
New-Item -ItemType Directory -Path (Join-Path $HerdrHome 'mods') -Force | Out-Null
New-Item -ItemType Directory -Path $ModDir -Force | Out-Null
$js = [IO.File]::ReadAllText((Join-Path $Payload 'mod\main.js'), [Text.Encoding]::UTF8)
$nodeJs = $node -replace '\\', '/'
$js2 = [regex]::Replace($js, 'const TOOL = "[^"]*";', { param($m) 'const TOOL = "' + $ToolPath + '";' })
$js2 = [regex]::Replace($js2, 'const NODE = "[^"]*";', { param($m) 'const NODE = "' + $nodeJs + '";' })
if ($js2 -eq $js -and $js -notmatch 'const TOOL = ') { Fail '모드 파일 형식이 예상과 다릅니다(const TOOL 을 찾지 못함).' }
Write-Utf8NoBom (Join-Path $ModDir 'main.js') $js2
foreach ($n in @('model.js', 'mod.json')) { Copy-Item -LiteralPath (Join-Path $Payload "mod\$n") -Destination (Join-Path $ModDir $n) -Force }
$chk = ''
try { $chk = (& $App check $ModDir 2>&1 | Out-String).Trim() } catch { $chk = "검사 실행 실패: $($_.Exception.Message)" }
Say "  공식 검사 결과: $chk"
if ($chk -match '(?i)error|fail|오류' -and $chk -notmatch '"errors":\s*\[\s*\]' -and $chk -notmatch '(?i)no (problems|errors)|ok') { Say '  경고: 검사에서 문제가 보고되었습니다. 위 내용을 확인하세요.' }

# ---------- 4) 키 연결 (Ctrl+Shift+R) ----------
Say '== 4/6 키 연결 =='
$Binding = '"ctrl-shift-r": "mod.open:session-keeper"'
if ($NoKey) { Say '  건너뜀(-NoKey). 팔레트: Ctrl+Shift+P -> mod.open session-keeper' }
elseif (-not (Test-Path -LiteralPath $KeysFile)) { Say '  keys.json 이 없어 건너뜁니다. 팔레트: Ctrl+Shift+P -> mod.open session-keeper' }
else {
    $raw = [IO.File]::ReadAllText($KeysFile, [Text.Encoding]::UTF8)
    $nl = $(if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" })
    if ($raw.Contains($Binding)) { Say '  이미 연결되어 있습니다 (Ctrl+Shift+R).' }
    elseif ($raw -match '"ctrl-shift-r"') { Say '  Ctrl+Shift+R 이 이미 다른 용도라 건너뜁니다. 팔레트: Ctrl+Shift+P -> mod.open session-keeper' }
    else {
        $m = [regex]::Match($raw, '"global"\s*:\s*\{\r?\n')
        if (-not $m.Success) { Say '  keys.json 의 "global" 구역을 찾지 못해 건너뜁니다. 팔레트: Ctrl+Shift+P -> mod.open session-keeper' }
        else {
            $new = $raw.Insert($m.Index + $m.Length, '    ' + $Binding + ',' + $nl)
            $okJson = $true; try { $null = $new | ConvertFrom-Json } catch { $okJson = $false }
            if (-not $okJson) { Say '  keys.json 수정 결과가 올바른 JSON 이 아니라 중단했습니다(파일 그대로).' }
            else {
                $bak = "$KeysFile.bak-before-session-keeper-kit"
                if (-not (Test-Path -LiteralPath $bak)) { Copy-Item -LiteralPath $KeysFile -Destination $bak }
                Write-Utf8NoBom $KeysFile $new
                Say '  연결 완료: Ctrl+Shift+R (원본 백업: keys.json.bak-before-session-keeper-kit)'
            }
        }
    }
}

# ---------- 5) 자동 실행 작업 ----------
Say '== 5/6 자동 실행 작업 =='
$taskOk = $false
if ($NoTask) { Say '  건너뜀(-NoTask). 키퍼는 수동으로: powershell -File session-keeper.ps1 -Mode Run' }
else {
    try {
        $vbs = Join-Path $InstallDir 'session-keeper-watchdog.vbs'
        $act = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B "' + $vbs + '"')
        $trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
        $set = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        $uid = $(if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME })
        $prn = New-ScheduledTaskPrincipal -UserId $uid -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trg -Settings $set -Principal $prn -Force -Description 'Herdr 앱이 켜져 있을 때만 세션키퍼를 켜 줍니다(1분 간격 점검).' | Out-Null
        $taskOk = $true
        Say "  작업 등록: $TaskName (Herdr 가 꺼져 있으면 아무것도 하지 않음)"
    } catch { Say "  경고: 작업 등록 실패($($_.Exception.Message)). 키퍼를 수동으로 켜세요: powershell -File `"$InstallDir\session-keeper.ps1`" -Mode Run" }
}

# ---------- 6) 마무리 ----------
Say '== 6/6 마무리 =='
if ($RestartKeeper) {
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { "$($_.CommandLine)" -like "*$InstallDir*session-keeper.ps1*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Say "  옛 키퍼 종료: pid $($_.ProcessId)" }
}
if ($Launcher) {
    Say '  런처 연결(바로가기 -> 업데이트 후 앱 실행)...'
    try { $env:KEEPER_NO_MAIN = $null; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallDir 'session-keeper.ps1') -Mode Update -Launcher Install | ForEach-Object { Say "    $_" } } catch { Say "  경고: 런처 연결 실패: $($_.Exception.Message)" }
}
$manifest = [ordered]@{ kit = 'herdr-session-keeper'; version = (Get-Content -LiteralPath (Join-Path $Payload 'VERSION') -ErrorAction SilentlyContinue | Select-Object -First 1); installedAt = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'); installDir = $InstallDir; herdrHome = $HerdrHome; modDir = $ModDir; taskName = $(if ($taskOk) { $TaskName } else { '' }); node = $node; herdrApp = $App; hc = "$hc"; keyBinding = (-not $NoKey); launcher = [bool]$Launcher }
Write-Utf8NoBom (Join-Path $InstallDir 'kit.install.json') (($manifest | ConvertTo-Json) + "`r`n")
if ($taskOk) { try { $ap = Get-Process herdr-app -ErrorAction SilentlyContinue; if ($ap) { Start-Process -FilePath 'wscript.exe' -ArgumentList ('//B "' + (Join-Path $InstallDir 'session-keeper-watchdog.vbs') + '"') -WindowStyle Hidden } } catch {} }
Say ''
Say '설치가 끝났습니다.'
Say '  - Herdr 화면에서 Ctrl+Shift+R 을 누르면 세션키퍼 창이 열립니다 (안 되면 Ctrl+Shift+P -> mod.open session-keeper).'
Say '  - 감시 프로그램은 Herdr 가 켜져 있을 때 1분 안에 자동으로 켜집니다.'
Say ('  - Herdr 앱 자동 업데이트: 기본 켜짐. 끄기: powershell -File "' + (Join-Path $InstallDir 'session-keeper.ps1') + '" -Mode Update -Auto Off')
Say "  - 제거: uninstall.ps1 (이 폴더에 있음)"
