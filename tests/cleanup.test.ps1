# cleanup-legacy.ps1 시험: 전부 임시 폴더에서 한다(실제 도구 폴더·설정 파일은 읽지도 쓰지도 않는다).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Script = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'cleanup-legacy.ps1'
$Base = Join-Path $env:TEMP ('session-keeper-cleanup-test-' + (Get-Date -Format 'yyyyMMddHHmmssfff'))
$script:pass = 0; $script:fail = 0
function Check([string]$name, [bool]$cond, [string]$detail = '') { if ($cond) { $script:pass++; Write-Host "PASS  $name" } else { $script:fail++; Write-Host "FAIL  $name  <-- $detail" } }
function Run([string]$tool, [string]$s1, [string]$s2, [string[]]$extra = @()) {
    return (& powershell -NoProfile -ExecutionPolicy Bypass -File $Script -ToolDir $tool -SettingsFiles "$s1;$s2" @extra 2>&1 | Out-String)
}
function Fixture([string]$name) {
    $d = Join-Path $Base $name; New-Item -ItemType Directory $d -Force | Out-Null
    foreach ($f in 'sid-statusline.mjs', 'apply-sid-statusline.ps1', 'session-picker.ps1', 'Herdr-Session-Picker.vbs', 'sessions.mjs', 'README.md', 'session-keeper.ps1') { Set-Content (Join-Path $d $f) "x-$f" }
    New-Item -ItemType Directory (Join-Path $d 'lib') -Force | Out-Null; Set-Content (Join-Path $d 'lib\common.mjs') 'lib'
    Set-Content (Join-Path $d 'settings-a.json') 'same'; Set-Content (Join-Path $d 'settings-a.json.bak-before-sid-statusline') 'same'      # 내용 같음 -> 지움
    Set-Content (Join-Path $d 'settings-b.json') 'now'; Set-Content (Join-Path $d 'settings-b.json.bak-before-sid-statusline') 'different'   # 내용 다름 -> 보관
    return $d
}
try {
    $d = Fixture 'main'; $a = Join-Path $d 'settings-a.json'; $b = Join-Path $d 'settings-b.json'
    $o = Run $d $a $b
    Check 'C1 미리보기(기본): 아무것도 지우지 않는다' ((Test-Path (Join-Path $d 'sid-statusline.mjs')) -and (Test-Path (Join-Path $d 'apply-sid-statusline.ps1')) -and (Test-Path "$a.bak-before-sid-statusline")) $o
    Check 'C2 미리보기: 지울 예정 3개(폐기 파일 2 + 같은 내용 백업 1), 다른 백업 1개는 보관, -Apply 안내' ($o -match '지울 예정 3 개' -and $o -match '-Apply' -and $o -match '보관 1 개') $o
    $o = Run $d $a $b @('-Apply')
    Check 'C3 -Apply: 폐기된 상태줄 파일 2개 삭제' (-not (Test-Path (Join-Path $d 'sid-statusline.mjs')) -and -not (Test-Path (Join-Path $d 'apply-sid-statusline.ps1'))) $o
    Check 'C4 -Apply: 설정과 내용이 같은 백업은 삭제' (-not (Test-Path "$a.bak-before-sid-statusline")) $o
    Check 'C5 -Apply: 설정과 내용이 다른 백업은 보관하고 알림' ((Test-Path "$b.bak-before-sid-statusline") -and $o -match '내용이 달라서 지우지 않음') $o
    Check 'C6 설정 파일 자체는 절대 건드리지 않는다' (((Get-Content $a -Raw).Trim() -eq 'same') -and ((Get-Content $b -Raw).Trim() -eq 'now'))
    Check 'C7 목록에 없는 파일·폴더는 그대로(sessions.mjs, README, session-keeper.ps1, lib\)' ((Test-Path (Join-Path $d 'sessions.mjs')) -and (Test-Path (Join-Path $d 'README.md')) -and (Test-Path (Join-Path $d 'session-keeper.ps1')) -and (Test-Path (Join-Path $d 'lib\common.mjs')))
    Check 'C8 -LegacyPicker 없이는 옛 별도 창을 지우지 않는다' ((Test-Path (Join-Path $d 'session-picker.ps1')) -and (Test-Path (Join-Path $d 'Herdr-Session-Picker.vbs'))) $o
    $o = Run $d $a $b @('-Apply')
    Check 'C9 다시 실행해도 오류 없이 "없음" 으로 끝난다(멱등)' ($o -match '없음' -and $o -notmatch '삭제 실패|Exception' -and $o -match '삭제 0 개') $o
    $o = Run $d $a $b @('-Apply', '-LegacyPicker')
    Check 'C10 -Apply -LegacyPicker: 옛 별도 창 2개도 삭제, 나머지는 그대로' ((-not (Test-Path (Join-Path $d 'session-picker.ps1'))) -and (-not (Test-Path (Join-Path $d 'Herdr-Session-Picker.vbs'))) -and (Test-Path (Join-Path $d 'sessions.mjs'))) $o
    $d2 = Fixture 'preview-legacy'; $o = Run $d2 (Join-Path $d2 'settings-a.json') (Join-Path $d2 'settings-b.json') @('-LegacyPicker')
    Check 'C11 -LegacyPicker 만(미리보기)이면 옛 별도 창도 지우지 않고 예정으로만 표시' ((Test-Path (Join-Path $d2 'session-picker.ps1')) -and $o -match '지울 예정\s+.*session-picker') $o
    $o = Run (Join-Path $Base 'no-such-dir') (Join-Path $Base 'no-a.json') (Join-Path $Base 'no-b.json') @('-Apply')
    Check 'C12 도구 폴더·설정 파일이 아예 없어도 오류 없이 끝난다' ($o -notmatch 'Exception|삭제 실패' -and $o -match '삭제 0 개') $o
    $d3 = Fixture 'no-settings'; Remove-Item (Join-Path $d3 'settings-a.json') -Force
    $o = Run $d3 (Join-Path $d3 'settings-a.json') (Join-Path $d3 'settings-b.json') @('-Apply')
    Check 'C13 현재 설정 파일이 없으면 백업을 지우지 않고 보관' ((Test-Path (Join-Path $d3 'settings-a.json.bak-before-sid-statusline')) -and $o -match '비교할 수 없음') $o
    $errs = $null; $tok = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tok, [ref]$errs)
    Check 'S1 스크립트 문법 오류 없음 + UTF-8 BOM' ($errs.Count -eq 0 -and (([IO.File]::ReadAllBytes($Script)[0..2] -join ',') -eq '239,187,191'))
    Check 'S2 스크립트에 폴더/재귀 삭제(-Recurse)나 와일드카드 삭제가 없다' (-not ([IO.File]::ReadAllText($Script) -match '-Recurse|Remove-Item[^\r\n]*\*'))
} finally {
    try { Remove-Item -LiteralPath $Base -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}
Write-Host "`n합계: PASS $script:pass / FAIL $script:fail"
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
