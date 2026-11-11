# install-herdr-mod.ps1 - Herdr 앱에 "session-keeper"(세션키퍼) 모드(AI 세션 목록 + 골라서 복구)를 설치/제거한다.
#
#   설치:  powershell -File install-herdr-mod.ps1        (다시 실행하면 새 버전으로 덮어씀)
#   제거:  powershell -File install-herdr-mod.ps1 -Uninstall
#
# 하는 일
#   1) herdr-mod\session-keeper 의 파일 2개(main.js, mod.json)를 Herdr 의 mods 폴더로 복사하고 공식 검사(herdr-app check)를 돌린다.
#   2) keys.json 의 "global" 맨 앞에 한 줄을 추가해 Ctrl+Shift+R 로 열리게 한다. (이전 버전의 Ctrl+Shift+S 연결은 지움)
#      (백업 .bak-before-claude-sessions 생성, 추가 후 JSON 이 깨졌으면 원래대로, 이미 있거나 다른 용도로 쓰이면 건너뜀)
# 건드리는 곳: mods\session-keeper 폴더(이전 이름 mods\claude-sessions 가 있으면 정리), keys.json 한 줄. 다른 모드·layouts·settings 는 손대지 않는다.
# (Herdr 는 이 파일들이 저장되면 즉시 다시 읽는다. 잘못된 파일이면 이전 버전을 유지한다.)
param([switch]$Uninstall)

$Src = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'herdr-mod\session-keeper'
$AppHome = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $env:USERPROFILE '.config\herdr-app' }
$Dest = Join-Path $AppHome 'mods\session-keeper'
$OldDest = Join-Path $AppHome 'mods\claude-sessions'      # 이전 이름(세션키퍼로 바뀌기 전). 설치할 때 정리한다
$App = Join-Path $env:LOCALAPPDATA 'Programs\herdr-app\herdr-app.exe'
$KeysFile = Join-Path $AppHome 'keys.json'
# 복사할 파일: 개발 폴더의 mod.json 과 모든 *.js (main.js 가 ./model.js 같은 모듈을 불러온다). Herdr 가 자동 생성하는 .d.ts·jsconfig.json 은 복사하지 않는다.
$Files = @()
if (Test-Path -LiteralPath $Src) { $Files = @(Get-ChildItem -LiteralPath $Src -File | Where-Object { $_.Name -eq 'mod.json' -or $_.Extension -eq '.js' } | ForEach-Object { $_.Name }) }
if ($Files -notcontains 'main.js' -or $Files -notcontains 'mod.json') { $Files = @('main.js', 'mod.json') }   # 개발 폴더가 이상하면 아래 "원본 파일이 없습니다" 안내로 이어진다
$Binding = '"ctrl-shift-r": "mod.open:session-keeper"'
$OldBindingPattern = '[ \t]*"ctrl-shift-[sr]"\s*:\s*"mod\.open:claude-sessions",?\r?\n'   # 이전 이름으로 연결했던 키(Ctrl+Shift+S/R)는 있으면 지운다

function Write-Utf8NoBom([string]$path, [string]$text) {
    $tmp = "$path.tmp-cs"
    [IO.File]::WriteAllBytes($tmp, (New-Object Text.UTF8Encoding($false)).GetBytes($text))
    Move-Item -LiteralPath $tmp -Destination $path -Force
}

function Set-KeyBinding([bool]$On) {
    if (-not (Test-Path -LiteralPath $KeysFile)) { Write-Host 'keys.json 이 없어 키 연결은 건너뜁니다.'; return }
    $raw = [IO.File]::ReadAllText($KeysFile, [Text.Encoding]::UTF8)
    $nl = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
    $new = [regex]::Replace($raw, $OldBindingPattern, '')          # 이전 버전의 Ctrl+Shift+S 연결은 항상 정리
    if ($On) {
        if ($new.Contains($Binding)) { if ($new -eq $raw) { Write-Host '키 연결: 이미 되어 있습니다 (Ctrl+Shift+R).'; return } }
        elseif ($new -match '"ctrl-shift-r"') { Write-Host '키 연결: Ctrl+Shift+R 가 이미 다른 용도로 쓰이고 있어 건너뜁니다. (팔레트: Ctrl+Shift+P -> mod.open session-keeper)'; return }
        else {
            $m = [regex]::Match($new, '"global"\s*:\s*\{\r?\n')
            if (-not $m.Success) { Write-Host 'keys.json 의 "global" 구역을 찾지 못해 키 연결은 건너뜁니다.'; return }
            $new = $new.Insert($m.Index + $m.Length, '    ' + $Binding + ',' + $nl)
        }
    } else {
        $new = [regex]::Replace($new, '[ \t]*"ctrl-shift-r"\s*:\s*"mod\.open:session-keeper",?\r?\n', '')
        if ($new -eq $raw) { return }
    }
    try { $null = $new | ConvertFrom-Json } catch { Write-Host 'keys.json 수정 결과가 올바른 JSON 이 아니라서 중단했습니다 (파일 그대로).'; return }
    $bak = "$KeysFile.bak-before-claude-sessions"
    if (-not (Test-Path -LiteralPath $bak)) { Copy-Item -LiteralPath $KeysFile -Destination $bak; Write-Host "keys.json 백업: $bak" }
    Write-Utf8NoBom $KeysFile $new
    Write-Host ($(if ($On) { '키 연결 완료: Ctrl+Shift+R' } else { '키 연결 제거 완료' }))
}

if ($Uninstall) {
    Set-KeyBinding $false
    $removed = $false
    foreach ($d in @($Dest, $OldDest)) {
        if ((Test-Path -LiteralPath $d) -and ($d.EndsWith('mods\session-keeper') -or $d.EndsWith('mods\claude-sessions'))) {
            Remove-Item -LiteralPath $d -Recurse -Force
            Write-Host "제거했습니다: $d"; $removed = $true
        }
    }
    if (-not $removed) { Write-Host '모드는 설치되어 있지 않습니다.' }
    return
}

foreach ($f in $Files) { if (-not (Test-Path -LiteralPath (Join-Path $Src $f))) { Write-Host "원본 파일이 없습니다: $Src\$f"; return } }
if (-not (Test-Path -LiteralPath (Join-Path $AppHome 'mods'))) { Write-Host "Herdr 설정 폴더를 찾지 못했습니다: $AppHome (Herdr 앱을 한 번 실행한 뒤 다시 시도하세요)"; return }

if ((Test-Path -LiteralPath $OldDest) -and $OldDest.EndsWith('mods\claude-sessions')) {   # 이전 이름의 모드가 남아 있으면 정리(세션키퍼로 교체)
    Remove-Item -LiteralPath $OldDest -Recurse -Force
    Write-Host "이전 이름의 모드를 정리했습니다: $OldDest"
}
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
foreach ($f in $Files) { Copy-Item -LiteralPath (Join-Path $Src $f) -Destination (Join-Path $Dest $f) -Force }
# main.js 의 const TOOL 은 이 설치 프로그램 옆 sessions.mjs 의 절대 경로로 채워 넣는다(저장소에는 개인 경로를 적어 두지 않는다)
$toolPath = ((Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'sessions.mjs') -replace '\\', '/')
$mjPath = Join-Path $Dest 'main.js'
$mjText = [IO.File]::ReadAllText($mjPath, [Text.Encoding]::UTF8)
Write-Utf8NoBom $mjPath ([regex]::Replace($mjText, 'const TOOL = "[^"]*";', { param($m) 'const TOOL = "' + $toolPath + '";' }))
Write-Host "복사 완료: $Dest"

if (Test-Path -LiteralPath $App) {
    $out = & $App check $Dest 2>&1 | Out-String
    Write-Host ("검사 결과: " + $out.Trim())
} else { Write-Host 'herdr-app.exe 를 찾지 못해 검사는 건너뜁니다.' }

Set-KeyBinding $true

Write-Host @'

사용법: Herdr 화면에서 Ctrl+Shift+R 을 누르세요.
        (안 되면 Ctrl+Shift+P 를 누르고 "mod.open session-keeper" 를 입력해 실행)
'@
