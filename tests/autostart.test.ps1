# 자동 시작 규칙 시험: "PC 부팅만으로는 켜지지 않고, Herdr 앱이 켜져 있을 때만 세션키퍼가 동작한다"
#   1) 감시 스크립트(session-keeper-watchdog.vbs): 앱이 없으면 아무것도 안 함 / 앱이 있고 키퍼가 살아 있으면 안 함 / 앱이 있고 키퍼가 없거나 심박이 낡았으면 시작
#   2) session-keeper.ps1 -Mode Run: 앱이 꺼져 있으면 Herdr 를 켜지 않고, AppGoneExitSec 뒤 스스로 끝낸다(임시 폴더 사본 + 별도 잠금 이름으로 실행 -> 실제 키퍼·기록은 건드리지 않음)
#   3) 정적 확인: Run 모드에 "앱을 직접 켜는" 코드가 없다
# 실제 Herdr 창은 읽기만 한다(hc ls). 실제 session-map.json / 심박 파일 / 로그는 쓰지 않는다.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$vbs = Join-Path $root 'session-keeper-watchdog.vbs'
$ps1 = Join-Path $root 'session-keeper.ps1'
$script:pass = 0; $script:fail = 0
function Check([string]$n, $c) { if ($c) { $script:pass++; "PASS  $n" } else { $script:fail++; "FAIL  $n" } }
$tmp = Join-Path $env:TEMP ('as-' + [guid]::NewGuid().ToString('N').Substring(0, 8)); New-Item -ItemType Directory $tmp | Out-Null

# ---- 1) 감시 스크립트
function Run-Vbs([string]$proc, [string]$alive) {
    $env:HERDR_WATCHDOG_DRY = '1'; $env:HERDR_WATCHDOG_ALIVE = $alive
    try { $o = & cscript.exe //Nologo $vbs $proc 2>&1 | Out-String } finally { Remove-Item Env:HERDR_WATCHDOG_DRY, Env:HERDR_WATCHDOG_ALIVE -ErrorAction SilentlyContinue }
    $o.Trim()
}
$fresh = Join-Path $tmp 'fresh.alive'; Set-Content $fresh '1|x|y'
$stale = Join-Path $tmp 'stale.alive'; Set-Content $stale '1|x|y'; (Get-Item $stale).LastWriteTime = (Get-Date).AddMinutes(-10)
$none = Join-Path $tmp 'none.alive'
Check '앱이 없으면(심박 신선) 아무것도 안 함' ((Run-Vbs 'no-such-proc-xyz.exe' $fresh) -eq 'SKIP-APP-DOWN')
Check '앱이 없으면(심박 없음) 아무것도 안 함 = 부팅만으로 키퍼가 시작되지 않음' ((Run-Vbs 'no-such-proc-xyz.exe' $none) -eq 'SKIP-APP-DOWN')
Check '앱이 없으면(심박 낡음) 아무것도 안 함' ((Run-Vbs 'no-such-proc-xyz.exe' $stale) -eq 'SKIP-APP-DOWN')
Check '앱이 있고 키퍼가 살아 있으면(심박 신선) 시작하지 않음' ((Run-Vbs 'powershell.exe' $fresh) -eq 'SKIP-ALIVE')
Check '앱이 있고 심박이 낡았으면 시작' ((Run-Vbs 'powershell.exe' $stale) -eq 'WOULD-START')
Check '앱이 있고 심박 파일이 없으면 시작' ((Run-Vbs 'powershell.exe' $none) -eq 'WOULD-START')
Check "이상한 프로세스 이름(따옴표)도 오류 없이 '앱 없음' 처리" ((Run-Vbs "x' OR '1'='1" $none) -eq 'SKIP-APP-DOWN')

# ---- 2) Run 모드: 앱이 꺼져 있으면 켜지 않고 스스로 종료
$dir2 = Join-Path $tmp 'copy'; New-Item -ItemType Directory $dir2 | Out-Null
$src = [IO.File]::ReadAllText($ps1, [Text.Encoding]::UTF8)
$mutexName = 'Local\HerdrSessionKeeperTest' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$copy = $src.Replace('Local\HerdrSessionKeeper''', $mutexName + '''')
Check '시험 사본의 잠금 이름이 바뀜(실제 키퍼와 충돌 없음)' ($copy -ne $src -and $copy.Contains($mutexName))
$copyPath = Join-Path $dir2 'session-keeper.ps1'
[IO.File]::WriteAllText($copyPath, $copy, (New-Object Text.UTF8Encoding($true)))
$appBefore = @(Get-Process herdr-app -ErrorAction SilentlyContinue).Count
$env:KEEPER_APP_PROC = 'no-such-proc-xyz'
$t0 = Get-Date
try {
    $p = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $copyPath, '-Mode', 'Run', '-AppGoneExitSec', '6') -PassThru -WindowStyle Hidden
    $done = $p.WaitForExit(150000)
} finally { Remove-Item Env:KEEPER_APP_PROC -ErrorAction SilentlyContinue }
$sec = ((Get-Date) - $t0).TotalSeconds
if (-not $done) { try { $p.Kill() } catch {} }
Check "앱이 꺼져 있으면 session-keeper 가 스스로 종료함 (${sec}초)" ($done -and $sec -lt 140)
$log = if (Test-Path (Join-Path $dir2 'session-keeper.log')) { Get-Content (Join-Path $dir2 'session-keeper.log') -Raw -Encoding UTF8 } else { '' }
Check '로그: 앱이 꺼져 있음을 알림' ($log -match '꺼져 있습니다')
Check '로그: 앱이 오래 꺼져 있어 종료한다고 기록' ($log -match '넘게 꺼져 있어 session-keeper 를 종료')
Check 'Herdr 앱을 직접 켰다는 기록이 없음' ($log -notmatch '앱을 실행했습니다')
Check 'Herdr 앱 프로세스 수가 그대로(키퍼가 앱을 켜지 않음)' (@(Get-Process herdr-app -ErrorAction SilentlyContinue).Count -eq $appBefore)
Check '정상 종료라 심박 파일이 지워짐' (-not (Test-Path (Join-Path $dir2 'session-keeper.alive')))

# ---- 3) 정적 확인
$runBody = ($src -split 'function Invoke-Run \{', 2)[1]; $runBody = ($runBody -split 'function Invoke-Forget', 2)[0]
Check 'Invoke-Run 안에 앱을 직접 켜는 Start-Process 가 없음' ($runBody -notmatch 'Start-Process')

Get-ChildItem $tmp -Recurse -File | Remove-Item -Force -ErrorAction SilentlyContinue
"합계: PASS $script:pass / FAIL $script:fail"
if ($script:fail) { exit 1 }
