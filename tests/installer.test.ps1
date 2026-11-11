# install-herdr-mod.ps1 시험 (전부 임시 폴더에서 한다. 실제 Herdr 설정·mods·keys.json 은 읽지도 쓰지도 않는다.)
# HERDR_APP_HOME 환경변수로 가짜 Herdr 설정 폴더를 가리켜 설치/재설치/제거와 예외 상황을 확인한다.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8     # 실행기(node)가 한글을 UTF-8 로 읽도록
$Installer = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'install-herdr-mod.ps1'
$DevMod = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'herdr-mod\session-keeper'
$Base = Join-Path $env:TEMP ('session-keeper-installer-test-' + (Get-Date -Format 'yyyyMMddHHmmssfff'))
$script:pass = 0; $script:fail = 0
function Check([string]$name, [bool]$cond, [string]$detail = '') { if ($cond) { $script:pass++; Write-Host "PASS  $name" } else { $script:fail++; Write-Host "FAIL  $name  <-- $detail" } }
function NewHome([string]$n) { $h = Join-Path $Base $n; New-Item -ItemType Directory (Join-Path $h 'mods') -Force | Out-Null; return $h }
function Install([string]$home_, [string[]]$extra = @()) {
    $env:HERDR_APP_HOME = $home_
    try { return (& powershell -NoProfile -ExecutionPolicy Bypass -File $Installer @extra 2>&1 | Out-String) } finally { $env:HERDR_APP_HOME = $null }
}
function WriteKeys([string]$h, [string]$text) { [IO.File]::WriteAllText((Join-Path $h 'keys.json'), $text) }
function ReadKeys([string]$h) { [IO.File]::ReadAllText((Join-Path $h 'keys.json')) }
$StdKeys = "{`n  `"global`": {`n    `"alt-1`": `"space.select:1`",`n    `"ctrl-shift-p`": `"app.palette`"`n  },`n  `"terminal`": {`n    `"ctrl-v`": `"terminal.paste_image`"`n  }`n}`n"

try {
    # 기본 설치 / 재설치 / 제거
    $h = NewHome 'basic'; WriteKeys $h $StdKeys; $orig = ReadKeys $h
    $o = Install $h
    $devFiles = @(Get-ChildItem $DevMod -File | Where-Object { $_.Name -eq 'mod.json' -or $_.Extension -eq '.js' } | ForEach-Object Name | Sort-Object)
    $insFiles = @(Get-ChildItem (Join-Path $h 'mods\session-keeper') -File | ForEach-Object Name | Sort-Object)
    $missingFiles = @($devFiles | Where-Object { $insFiles -notcontains $_ })      # (설치 뒤 Herdr 검사가 만드는 gpui-kit.d.ts 등 자동 생성 파일은 무시)
    Check 'B1 설치: 개발본의 모드 파일(mod.json, *.js)이 모두 복사됨' ($missingFiles.Count -eq 0 -and $devFiles.Count -ge 2) "빠진 파일=$($missingFiles -join ',')"
    Check 'B1b 설치: main.js 가 불러오는 model.js 도 복사됨(빠지면 창이 안 열림)' ((Test-Path (Join-Path $DevMod 'model.js')) -and (Test-Path (Join-Path $h 'mods\session-keeper\model.js')))
    $same = $true; foreach ($f in @($devFiles | Where-Object { $_ -ne 'main.js' })) { if ((Get-FileHash (Join-Path $DevMod $f)).Hash -ne (Get-FileHash (Join-Path $h "mods\session-keeper\$f")).Hash) { $same = $false } }
    Check 'B2 설치: 복사본 내용이 개발본과 동일' $same
    $after = ReadKeys $h
    Check 'B3 설치: keys.json 에 Ctrl+Shift+R 한 줄만 추가, 유효 JSON' ($after.Contains('"ctrl-shift-r": "mod.open:session-keeper"') -and [bool]($after | ConvertFrom-Json) -and (($after -split "`n").Count -eq ($orig -split "`n").Count + 1))
    Check 'B4 설치: 백업 생성' (Test-Path (Join-Path $h 'keys.json.bak-before-claude-sessions'))
    $o2 = Install $h; Check 'B5 재설치(멱등): keys.json 변화 없음' ((ReadKeys $h) -eq $after -and $o2 -match '이미 되어 있습니다') $o2
    $o3 = Install $h @('-Uninstall'); Check 'B6 제거: 키·모드 폴더 모두 원상복구' ((ReadKeys $h) -eq $orig -and -not (Test-Path (Join-Path $h 'mods\session-keeper'))) $o3

    # 이전 이름(claude-sessions) 정리
    $h = NewHome 'migrate'; $old = "{`n  `"global`": {`n    `"ctrl-shift-s`": `"mod.open:claude-sessions`",`n    `"alt-1`": `"space.select:1`"`n  }`n}`n"; WriteKeys $h $old
    New-Item -ItemType Directory (Join-Path $h 'mods\claude-sessions') -Force | Out-Null; Set-Content (Join-Path $h 'mods\claude-sessions\main.js') 'old'
    $o = Install $h; $after = ReadKeys $h
    Check 'M1 옛 이름 모드 폴더 정리 + 새 폴더 설치' (-not (Test-Path (Join-Path $h 'mods\claude-sessions')) -and (Test-Path (Join-Path $h 'mods\session-keeper\main.js'))) $o
    Check 'M2 옛 Ctrl+Shift+S 연결 제거, 새 Ctrl+Shift+R 연결, 다른 키 보존' (-not $after.Contains('claude-sessions') -and $after.Contains('"ctrl-shift-r": "mod.open:session-keeper"') -and $after.Contains('"alt-1"') -and [bool]($after | ConvertFrom-Json)) $after
    $h = NewHome 'migrate-r'; WriteKeys $h "{`n  `"global`": {`n    `"ctrl-shift-r`": `"mod.open:claude-sessions`",`n    `"alt-1`": `"space.select:1`"`n  }`n}`n"
    $null = Install $h; $after = ReadKeys $h
    Check 'M3 옛 이름이 R 키에 연결돼 있던 경우 새 이름으로 교체, 키 중복 없음' ($after.Contains('mod.open:session-keeper') -and -not $after.Contains('claude-sessions') -and (([regex]::Matches($after, 'ctrl-shift-r')).Count -eq 1) -and [bool]($after | ConvertFrom-Json)) $after

    # 예외 상황
    $h = NewHome 'nokeys'; $o = Install $h; Check 'E1 keys.json 없음 -> 키 연결만 건너뛰고 모드는 설치' ($o -match 'keys.json 이 없어' -and (Test-Path (Join-Path $h 'mods\session-keeper\main.js'))) $o
    $h = NewHome 'noglobal'; WriteKeys $h '{ "terminal": { "ctrl-v": "terminal.paste" } }'; $b = ReadKeys $h; $o = Install $h
    Check 'E2 "global" 구역 없음 -> 건너뜀, keys.json 불변' ($o -match 'global' -and (ReadKeys $h) -eq $b) $o
    $h = NewHome 'conflict'; WriteKeys $h "{`n  `"global`": {`n    `"ctrl-shift-r`": `"tab.new`",`n    `"alt-1`": `"space.select:1`"`n  }`n}`n"; $b = ReadKeys $h; $o = Install $h
    Check 'E3 R 키가 이미 다른 용도 -> 덮어쓰지 않고 건너뜀' ($o -match '다른 용도' -and (ReadKeys $h) -eq $b) $o
    $h = NewHome 'broken'; WriteKeys $h "{`n  `"global`": {`n    `"alt-1`": `"space.select:1`"`n    `"alt-2`": `"space.select:2`"`n  }`n}`n"; $b = ReadKeys $h; $o = Install $h
    Check 'E4 이미 깨진 keys.json -> 수정 중단, 파일 불변, 백업 안 남김' ($o -match '올바른 JSON' -and (ReadKeys $h) -eq $b -and -not (Test-Path (Join-Path $h 'keys.json.bak-before-claude-sessions'))) $o
    $h = NewHome 'crlf'; WriteKeys $h ($StdKeys -replace "`n", "`r`n"); $null = Install $h; $after = ReadKeys $h
    Check 'E5 CRLF 파일 -> CRLF 유지, 줄 섞임 없음, 유효 JSON' ((-not ($after -match '(?<!\r)\n')) -and [bool]($after | ConvertFrom-Json) -and $after.Contains('ctrl-shift-r'))
    $h = Join-Path $Base 'nomods'; New-Item -ItemType Directory $h -Force | Out-Null; $o = Install $h
    Check 'E6 Herdr 설정 폴더(mods) 없음 -> 안내 후 중단, 아무것도 만들지 않음' ($o -match '설정 폴더를 찾지 못' -and -not (Test-Path (Join-Path $h 'mods'))) $o
    $h = NewHome 'notinstalled'; $o = Install $h @('-Uninstall'); Check 'E7 설치 안 된 상태에서 -Uninstall -> 오류 없이 안내' ($o -match '설치되어 있지 않습니다' -and $o -notmatch 'Exception') $o
    $h = Join-Path $Base 'path with space 한글'; New-Item -ItemType Directory (Join-Path $h 'mods') -Force | Out-Null; WriteKeys $h $StdKeys; $null = Install $h
    Check 'E8 경로에 공백·한글 -> 정상 설치' ((Test-Path (Join-Path $h 'mods\session-keeper\main.js')) -and (ReadKeys $h).Contains('ctrl-shift-r'))

    # 스크립트 자체 점검
    $errs = $null; $tok = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$tok, [ref]$errs)
    Check 'S1 설치 스크립트 문법 오류 없음' ($errs.Count -eq 0)
    Check 'S2 설치 스크립트가 UTF-8 BOM 으로 저장됨(한글 안 깨짐)' (([IO.File]::ReadAllBytes($Installer)[0..2] -join ',') -eq '239,187,191')
} finally {
    $env:HERDR_APP_HOME = $null
    try { Remove-Item -LiteralPath $Base -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}
Write-Host "`n합계: PASS $script:pass / FAIL $script:fail"
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
