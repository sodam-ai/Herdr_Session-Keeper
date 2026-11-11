# uninstall.ps1 - 세션키퍼 제거. install.ps1 이 남긴 설치 기록(kit.install.json)을 읽어 설치한 것만 되돌립니다.
#   powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1            (프로그램·모드·작업·키 연결 제거, 기록/로그 데이터는 남김)
#   ... -RemoveData                                                              (설치 폴더 전체 삭제: 복구 대기 기록·로그 포함)
# Herdr 앱·Herdr 의 터미널·다른 모드·Claude/Codex 대화 기록은 건드리지 않습니다.
param(
    [string]$InstallDir = '',
    [string]$HerdrHome = '',
    [string]$TaskName = '',
    [switch]$RemoveData
)
$ErrorActionPreference = 'Continue'
function Say([string]$m) { Write-Host $m }
function Write-Utf8NoBom([string]$path, [string]$text) {
    $tmp = "$path.tmp-kit"
    [IO.File]::WriteAllBytes($tmp, (New-Object Text.UTF8Encoding($false)).GetBytes($text))
    Move-Item -LiteralPath $tmp -Destination $path -Force
}
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'HerdrSessionKeeper\app' }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$mf = $null
$mfPath = Join-Path $InstallDir 'kit.install.json'
if (Test-Path -LiteralPath $mfPath) { try { $mf = [IO.File]::ReadAllText($mfPath, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch {} }
if (-not $mf -and -not (Test-Path -LiteralPath (Join-Path $InstallDir 'session-keeper.ps1'))) { Say "이 위치에는 설치된 세션키퍼가 없습니다: $InstallDir"; exit 0 }
if (-not $HerdrHome) { $HerdrHome = $(if ($mf -and $mf.herdrHome) { $mf.herdrHome } elseif ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $env:USERPROFILE '.config\herdr-app' }) }
if (-not $TaskName) { $TaskName = $(if ($mf -and $mf.taskName) { $mf.taskName } else { 'HerdrSessionKeeper-Watchdog' }) }

Say '== 세션키퍼 제거 =='
# 1) 런처 해제(연결했던 경우): 바로가기를 원래대로
if ($mf -and $mf.launcher -and (Test-Path -LiteralPath (Join-Path $InstallDir 'session-keeper.ps1'))) {
    try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallDir 'session-keeper.ps1') -Mode Update -Launcher Uninstall | ForEach-Object { Say "  $_" } } catch { Say "  경고: 런처 해제 실패: $($_.Exception.Message)" }
}
# 2) 자동 실행 작업: 이 설치를 가리키는 것만
try {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) {
        $a = ($t.Actions | ForEach-Object { "$($_.Arguments)" }) -join ' '
        if ($a -like "*$InstallDir*") { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Say "  작업 제거: $TaskName" } else { Say "  작업 '$TaskName' 은 다른 위치를 가리켜 그대로 둡니다." }
    } else { Say '  자동 실행 작업: 없음' }
} catch { Say "  경고: 작업 제거 실패: $($_.Exception.Message)" }
# 3) 이 설치의 키퍼 프로세스 종료
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { "$($_.CommandLine)" -like "*$InstallDir*session-keeper.ps1*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Say "  키퍼 종료: pid $($_.ProcessId)" }
# 4) 키 연결 + 모드 (모드가 이 설치를 가리킬 때만)
$ModDir = Join-Path $HerdrHome 'mods\session-keeper'
$mainJs = Join-Path $ModDir 'main.js'
$ours = $false
if (Test-Path -LiteralPath $mainJs) { $m0 = [regex]::Match([IO.File]::ReadAllText($mainJs, [Text.Encoding]::UTF8), 'const TOOL = "([^"]*)";'); $ours = ($m0.Success -and $m0.Groups[1].Value -eq ((Join-Path $InstallDir 'sessions.mjs') -replace '\\', '/')) }
if ($ours) {
    $KeysFile = Join-Path $HerdrHome 'keys.json'
    if (Test-Path -LiteralPath $KeysFile) {
        $raw = [IO.File]::ReadAllText($KeysFile, [Text.Encoding]::UTF8)
        $new = [regex]::Replace($raw, '[ \t]*"ctrl-shift-r"\s*:\s*"mod\.open:session-keeper",?\r?\n', '')
        if ($new -ne $raw) { $ok = $true; try { $null = $new | ConvertFrom-Json } catch { $ok = $false }; if ($ok) { Write-Utf8NoBom $KeysFile $new; Say '  키 연결 제거: Ctrl+Shift+R' } else { Say '  keys.json 수정 결과가 올바르지 않아 그대로 둡니다.' } }
    }
    Remove-Item -LiteralPath $ModDir -Recurse -Force -ErrorAction SilentlyContinue; Say "  모드 제거: $ModDir"
} elseif (Test-Path -LiteralPath $ModDir) { Say '  Herdr 모드는 다른 위치의 세션키퍼가 쓰고 있어 그대로 둡니다.' } else { Say '  Herdr 모드: 없음' }
# 5) 프로그램 파일 (데이터는 기본 보존)
if ($RemoveData) {
    if ($mf -or (Test-Path -LiteralPath (Join-Path $InstallDir 'kit.env'))) { Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue; Say "  설치 폴더 전체 삭제: $InstallDir" }
    else { Say '  설치 기록이 없어 폴더 전체 삭제는 하지 않았습니다.' }
} else {
    foreach ($n in @('session-keeper.ps1', 'sessions.mjs', 'scan-monitors.mjs', 'session-keeper-watchdog.vbs', 'herdr-launch.ps1', 'herdr-launch.vbs', 'kit.env', 'kit.install.json', 'README-program.md')) { Remove-Item -LiteralPath (Join-Path $InstallDir $n) -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath (Join-Path $InstallDir 'lib') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $InstallDir '_backup') -Recurse -Force -ErrorAction SilentlyContinue
    Say "  프로그램 파일 제거. 복구 대기 기록·로그는 남겼습니다: $InstallDir  (모두 지우려면 -RemoveData)"
}
Say '제거가 끝났습니다. (Herdr 앱·터미널·Claude/Codex 대화 기록은 그대로입니다)'
