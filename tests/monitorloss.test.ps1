# 복구 결과 요약의 "감시·예약 재가동 필요" 알림 시험: 키퍼 함수(Get-MonitorLoss, Write-RestoreSummary) -> scan-monitors.mjs 까지 실제로 돌린다.
# 가짜 대화 파일·가짜 키퍼 폴더·가짜 APPDATA 만 쓴다(실제 기록·Herdr 는 읽지도 쓰지도 않는다).
# 마지막 줄 "합계: PASS n / FAIL m" 형식은 run-all 이 읽는다.
$env:KEEPER_NO_MAIN = '1'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'session-keeper.ps1')
$script:pass = 0; $script:fail = 0
function Check([string]$n, $c) { if ($c) { $script:pass++; "PASS  $n" } else { $script:fail++; "FAIL  $n" } }

# 실제 Claude 대화 파일처럼 BOM 없는 UTF-8 로 쓴다(BOM 이 붙으면 첫 줄이 JSON 으로 읽히지 않는다)
function Write-Lines($path, $lines) { [IO.File]::WriteAllLines($path, [string[]]@($lines), (New-Object Text.UTF8Encoding($false))) }
$T = Join-Path $env:TEMP ('mloss-' + [guid]::NewGuid().ToString('N').Substring(0, 8)); New-Item -ItemType Directory $T | Out-Null
Copy-Item (Join-Path (Split-Path -Parent $PSScriptRoot) 'scan-monitors.mjs') $T
$proj = Join-Path $T 'appdata\claude-code\projects\x'; New-Item -ItemType Directory -Force $proj | Out-Null
$env:APPDATA = Join-Path $T 'appdata'
$Dir = $T; $LogFile = Join-Path $T 'k.log'; $SummaryFile = Join-Path $T 'LAST-RESTORE.txt'; $HistoryFile = Join-Path $T 'hist.log'

# 시각: 닫히기 직전 = 2026-11-10 12:10(UTC)
$shutUtc = [datetime]::SpecifyKind([datetime]'2026-11-10T12:10:00', 'Utc')
$use = { param($ts, $id, $name, $inp) (@{ type = 'assistant'; timestamp = $ts; message = @{ content = @(@{ type = 'tool_use'; id = $id; name = $name; input = $inp }) } } | ConvertTo-Json -Depth 8 -Compress) }
$res = { param($ts, $id, $task, $ms) (@{ type = 'user'; timestamp = $ts; message = @{ content = @(@{ type = 'tool_result'; tool_use_id = $id }) }; toolUseResult = @{ taskId = $task; timeoutMs = $ms; persistent = $false } } | ConvertTo-Json -Depth 8 -Compress) }
$sidOn = [guid]::NewGuid().ToString(); $sidExpired = [guid]::NewGuid().ToString(); $sidStopped = [guid]::NewGuid().ToString(); $sidNone = [guid]::NewGuid().ToString()
# 켜져 있음: 12:00 에 30분짜리 감시 시작(12:10 에도 켜짐)
Write-Lines (Join-Path $proj "$sidOn.jsonl") @((& $use '2026-11-10T12:00:00.000Z' 'u1' 'Monitor' @{ description = '승인 자동 누르기' }), (& $res '2026-11-10T12:00:01.000Z' 'u1' 'b1' 1800000))
# 이미 끝남: 10:00 시작 30분짜리(12:10 에는 만료)
Write-Lines (Join-Path $proj "$sidExpired.jsonl") @((& $use '2026-11-10T10:00:00.000Z' 'u2' 'Monitor' @{ description = '옛 감시' }), (& $res '2026-11-10T10:00:01.000Z' 'u2' 'b2' 1800000))
# 직접 끔: 12:00 시작, 12:05 TaskStop
Write-Lines (Join-Path $proj "$sidStopped.jsonl") @((& $use '2026-11-10T12:00:00.000Z' 'u3' 'Monitor' @{ description = '끈 감시' }), (& $res '2026-11-10T12:00:01.000Z' 'u3' 'b3' 1800000), (& $use '2026-11-10T12:05:00.000Z' 'u4' 'TaskStop' @{ task_id = 'b3' }))
Write-Lines (Join-Path $proj "$sidNone.jsonl") @((& $use '2026-11-10T12:00:00.000Z' 'u5' 'Bash' @{ command = 'ls' }))
$map = [ordered]@{}
foreach ($p in @(@('t1', $sidOn), @('t2', $sidExpired), @('t3', $sidStopped), @('t4', $sidNone))) { $map[$p[0]] = @{ addr = $p[0]; where = "공간 / $($p[0])"; sid = $p[1]; cwd = 'C:\x'; boot = '2026-11-10T00:00:00'; seen = '2026-11-10T21:00:00'; orphan = $false } }
[IO.File]::WriteAllText((Join-Path $T 'session-map.json'), ($map | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($true)))
$script:SidByAddr = @{ t1 = $sidOn; t2 = $sidExpired; t3 = $sidStopped; t4 = $sidNone }
$rows = @(foreach ($a in 't1', 't2', 't3', 't4') { [pscustomobject]@{ addr = $a; where = "공간 / $a"; state = '성공'; detail = '실행 확인'; at = '00:00:00' } })

# 1) 기준 시각이 없으면(자동 복구가 아니었음) 확인하지 않는다
$script:ShutdownAt = $null
Check '닫히기 직전 시각이 없으면 확인을 건너뛴다' (@(Get-MonitorLoss $rows).Count -eq 0)
# 2) 기준 시각이 있으면 "그 시각에 켜져 있던 것"만 찾는다
$script:ShutdownAt = $shutUtc.ToLocalTime()
$loss = @(Get-MonitorLoss $rows)
Check '켜져 있던 감시 1개만 찾는다(만료된 것·직접 끈 것·감시 없는 것은 제외)' ($loss.Count -eq 1 -and $loss[0].sid -eq $sidOn -and $loss[0].addr -eq 't1') 
Check '감시 설명이 함께 온다' ($loss.Count -eq 1 -and (@($loss[0].desc) -join '') -match '승인 자동 누르기')
# 3) 복구에 성공하지 못한 창은 확인 대상이 아니다
$rowsFail = @([pscustomobject]@{ addr = 't1'; where = 'w'; state = '실패'; detail = 'x'; at = '0' })
Check '성공하지 않은 창은 확인하지 않는다' (@(Get-MonitorLoss $rowsFail).Count -eq 0)
# 4) 요약 파일: 판정이 "정상"이 아니라 "주의 - 대화는 전부 복구됨 · 감시·예약 재가동 필요 1 개"
$script:Outcome = @{}; foreach ($r in $rows) { $script:Outcome[$r.addr] = $r }
$script:PrevInfo = 'test'; $script:WinOpenAt = '00:00:00'; $script:RecentInfo = $null
Write-RestoreSummary $false
$txt = [IO.File]::ReadAllText($SummaryFile)
Check '요약 판정: 주의 - 대화는 전부 복구됨 · 감시·예약 재가동 필요 1 개' ($txt -match '(?m)^판정: 주의 - 대화는 전부 복구됨 · 감시·예약 재가동 필요 1 개')
Check '요약에 창 목록과 "자동으로 켜지 않습니다" 안내가 있다' ($txt -match '감시·예약 재가동 필요 1개' -and $txt -match '자동으로 켜지 않습니다' -and $txt -match 't1\s+공간 / t1')
# 5) 감시가 없으면 예전처럼 "정상"
$script:ShutdownAt = $null
Write-RestoreSummary $false
Check '감시·예약이 없으면 판정은 예전 그대로 "정상"' ([IO.File]::ReadAllText($SummaryFile) -match '(?m)^판정: 정상 - 전부 복구됨')
# 6) 고장 대비: scan 스크립트가 없어도 예외 없이 빈 결과(복구 결과에 영향 없음)
$script:ShutdownAt = $shutUtc.ToLocalTime(); Remove-Item (Join-Path $T 'scan-monitors.mjs') -Force
$err = $null; $r6 = @(); try { $r6 = @(Get-MonitorLoss $rows) } catch { $err = $_.Exception.Message }
Check '확인 도구가 없어도 예외 없이 빈 결과' (-not $err -and $r6.Count -eq 0)
Get-ChildItem $T -Recurse -File | Remove-Item -Force
"합계: PASS $script:pass / FAIL $script:fail"
if ($script:fail -gt 0) { exit 1 }
