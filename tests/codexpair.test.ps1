# Codex 창 <-> 대화 짝짓기(Get-CodexPairs) 와 새 탭 생성 허용(Test-AllowCreate) 시험. 가짜 rollout 파일(임시 폴더)만 쓰고 실제 Codex/Herdr 는 건드리지 않는다.
#   - `codex resume <ID>` 로 켠 창은 같은 폴더에 창이 여러 개여도 명령줄의 ID 로 확정된다(키퍼가 복구한 창이 전부 이 모양)
#   - 확정 못 하는 창(새로 켠 창 둘 이상이 같은 폴더)은 여전히 'ambiguous' (틀린 대화를 이어 붙이지 않는다)
$env:KEEPER_NO_MAIN = '1'
. (Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'session-keeper.ps1')
$script:pass = 0; $script:fail = 0
function Check([string]$n, $c) { if ($c) { $script:pass++; "PASS  $n" } else { $script:fail++; "FAIL  $n" } }

$tmp = Join-Path $env:TEMP ('cp-' + [guid]::NewGuid().ToString('N').Substring(0, 8)); New-Item -ItemType Directory $tmp | Out-Null
$CodexSessDir = $tmp
$script:CodexHeadCache = @{}
$script:ProcInfo = @{}
$script:CodexScreenReader = { param($a) '' }      # 실제 hc read 를 부르지 않는다(화면은 아래 G 구간에서만 가짜로 넣는다)
$cwd = 'C:\Users\tester'
function New-Rollout([string]$id, [int]$minAgo = 1, [string]$cwdVal = $cwd) {
    $f = Join-Path $tmp "rollout-2026-11-09T00-00-00-$id.jsonl"
    $obj = @{ payload = @{ id = $id; cwd = $cwdVal; originator = 'codex-tui'; source = 'cli' } } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($f, $obj + "`n", (New-Object Text.UTF8Encoding($false)))
    (Get-Item $f).LastWriteTime = (Get-Date).AddMinutes(-$minAgo)
    $f
}
function New-Term([string]$cmd, [int]$startedMinAgo = 30, [string]$c = $cwd) {
    @{ g = @{ cwd = $c; foreground = @{ cwd = $c } }; root = @{ pid = 1; created = (Get-Date).AddMinutes(-$startedMinAgo); cmd = $cmd } }
}
$idA = '01a0d0f0-aa8d-7020-90b6-4780f6a4adcb'; $idB = '01a0b1c4-0291-7b10-acf9-6da24ca785b6'; $idC = '01a0b673-70cd-74c0-9c10-fc945ad9aff5'
$fA = New-Rollout $idA; $fB = New-Rollout $idB 60; $fC = New-Rollout $idC 2   # B 는 창들이 켜지기 전(60분 전)에 마지막으로 갱신된 대화
$nodeCmd = { param($id) "`"C:\Program Files\nodejs\node.exe`" C:\Users\tester\AppData\Roaming\npm/node_modules/@openai/codex/bin/codex.js resume $id" }
$fresh = '"C:\Program Files\nodejs\node.exe" C:\Users\tester\AppData\Roaming\npm/node_modules/@openai/codex/bin/codex.js '

# A) 같은 폴더의 resume 창 둘 -> 각자 자기 ID 로 확정
$r = Get-CodexPairs @{ t1 = (New-Term (& $nodeCmd $idA)); t2 = (New-Term (& $nodeCmd $idB)) }
Check 'resume 창 2개(같은 폴더): 둘 다 확정' ($r.t1.status -eq 'ok' -and $r.t2.status -eq 'ok')
Check 'resume 창 2개: 각 창이 자기 ID 로 짝지어짐' ($r.t1.id -eq $idA -and $r.t2.id -eq $idB)
Check 'resume 창: 대화 파일 경로와 방식(resume)이 기록됨' ($r.t1.file -eq $fA -and $r.t1.how -eq 'resume')

# B) 대화 파일이 없는 ID -> resume 로 확정하지 않는다(틀린 ID 를 적지 않음)
$ghost = '01aaaaaa-0000-7000-8000-000000000000'
$r = Get-CodexPairs @{ t1 = (New-Term (& $nodeCmd $ghost) 60 'C:\Other') }
Check '대화 파일이 없는 resume ID 는 확정하지 않음' ($r.t1.status -ne 'ok' -or $r.t1.id -ne $ghost)

# C) resume 창 하나 + 새로 켠 창 하나(같은 폴더): resume 창은 확정, 새 창은 남은 후보로 추정(확정된 ID 는 후보에서 제외)
$r = Get-CodexPairs @{ t1 = (New-Term (& $nodeCmd $idA)); t2 = (New-Term $fresh 30) }
Check 'resume 1 + 새 창 1: resume 창 확정' ($r.t1.status -eq 'ok' -and $r.t1.id -eq $idA)
Check 'resume 1 + 새 창 1: 새 창은 남은 후보(C)로 짝지어짐(확정된 A 는 가져가지 않음)' ($r.t2.status -eq 'ok' -and $r.t2.id -eq $idC -and $r.t2.id -ne $idA)

# D) 새로 켠 창 둘이 같은 폴더 -> 기존처럼 모호함으로 처리
$r = Get-CodexPairs @{ t1 = (New-Term $fresh 30); t2 = (New-Term $fresh 30) }
Check '새 창 2개(같은 폴더): 모호함(ambiguous) 유지 - 틀린 대화를 이어 붙이지 않음' ($r.t1.status -eq 'ambiguous' -and $r.t2.status -eq 'ambiguous')

# E) 이상한 명령줄
$r = Get-CodexPairs @{ t1 = (New-Term 'node codex.js resume not-a-uuid' 30) }
Check "resume 뒤가 UUID 가 아니면 무시(예외 없음)" ($null -ne $r.t1 -and $r.t1.status -ne 'ok' -or ($r.t1.status -eq 'ok' -and $r.t1.how -ne 'resume'))
$r = Get-CodexPairs @{ t1 = (New-Term '' 30) }
Check '명령줄이 비어 있어도 예외 없음' ($null -ne $r.t1)
$r = Get-CodexPairs @{ t1 = (New-Term ((& $nodeCmd $idA).ToUpper().Replace('CODEX.JS', 'codex.js').Replace('RESUME', 'resume')) 30) }
Check '대문자 UUID 도 소문자 ID 로 확정' ($r.t1.status -eq 'ok' -and $r.t1.id -eq $idA)

# F) 새 탭 생성 허용 판단
Check 'Test-AllowCreate: 코어 200초 -> 허용' (Test-AllowCreate 200 0 120)
Check 'Test-AllowCreate: 코어 5초 + 창 500초 -> 아직(코어 유예 유지)' (-not (Test-AllowCreate 5 500 120))
Check 'Test-AllowCreate: 코어 시작 못 찾음(-1) + 창 50초 -> 아직' (-not (Test-AllowCreate -1 50 120))
Check 'Test-AllowCreate: 코어 시작 못 찾음(-1) + 창 130초 -> 허용(영영 막히지 않음)' (Test-AllowCreate -1 130 120)
Check 'Test-AllowCreate: 코어 0초(방금 시작) + 창 500초 -> 아직' (-not (Test-AllowCreate 0 500 120))
Check 'Get-CoreAgeSec: 못 찾으면 음수, 찾으면 0 이상' ((Get-CoreAgeSec) -ge -1)

# G) 같은 폴더의 새 창 둘: 화면에 보이는 최근 발화로 대화를 가린다(창과 대화가 서로 유일하게 맞을 때만 확정)
$gc = 'C:\Work\G'      # G 구간 전용 폴더(위 A~F 구간의 내용 없는 대화 파일과 섞이지 않게)
function New-ChatRollout([string]$id, [string[]]$msgs) {
    $f = Join-Path $tmp "rollout-2026-11-11T00-00-00-$id.jsonl"
    $rows = @(@{ type = 'session_meta'; payload = @{ id = $id; cwd = $gc; originator = 'codex-tui'; source = 'cli' } })
    $rows += @{ type = 'response_item'; payload = @{ type = 'message'; role = 'user'; content = @(@{ type = 'input_text'; text = "# AGENTS.md instructions for $cwd`n<INSTRUCTIONS>공통 안내문 같은 줄 같은 줄 같은 줄</INSTRUCTIONS>" }) } }
    $i = 0; foreach ($m in $msgs) { $i++; $rows += @{ type = 'response_item'; payload = @{ type = 'message'; role = $(if ($i % 2) { 'user' } else { 'assistant' }); content = @(@{ type = 'text'; text = $m }) } } }
    [IO.File]::WriteAllText($f, (($rows | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 6 }) -join "`n") + "`n", (New-Object Text.UTF8Encoding($false)))
    (Get-Item $f).LastWriteTime = (Get-Date).AddMinutes(-1)
    $f
}
$idX1 = '01a1c000-0000-7000-8000-0000000000a1'; $idX2 = '01a1c000-0000-7000-8000-0000000000a2'
$pA = '알파 프로젝트 배포 체크리스트를 검토해 주세요 그리고 위험 요소를 알려 주세요'; $pB = '베타 데이터베이스 마이그레이션 되돌리기 계획을 작성해 주세요 단계별로'
$null = New-ChatRollout $idX1 @($pA, '네 확인하겠습니다'); $null = New-ChatRollout $idX2 @($pB, '계획을 작성했습니다')
$script:CodexSigCache = @{}; $script:CodexScreenCache = @{}
$wrap = { param($s) ($s -replace '(.{20})', "`$1`n  ") }                                      # 화면에서는 긴 줄이 접혀 보인다
$script:CodexScreenReader = { param($a) if ($a -eq 'g1') { "› $(& $wrap $pA)`n• 네 확인하겠습니다" } else { "› $(& $wrap $pB)`n• 계획을 작성했습니다" } }
$r = Get-CodexPairs @{ g1 = (New-Term $fresh 30 $gc); g2 = (New-Term $fresh 30 $gc) }
Check '화면 대조: 같은 폴더 새 창 2개가 각자 자기 대화로 확정(접힌 줄도 인식)' ($r.g1.status -eq 'ok' -and $r.g1.id -eq $idX1 -and $r.g2.status -eq 'ok' -and $r.g2.id -eq $idX2)
Check '화면 대조: 확정 방식이 screen 으로 기록됨' ($r.g1.how -eq 'screen')
$script:CodexScreenCache = @{}
$script:CodexScreenReader = { param($a) "$pA $pB" }                                          # 두 창 화면에 두 대화가 다 보이면 가릴 수 없다
$r = Get-CodexPairs @{ g1 = (New-Term $fresh 30 $gc); g2 = (New-Term $fresh 30 $gc) }
Check '화면 대조: 두 창이 같은 대화와 맞으면 둘 다 확정하지 않음(모호함 유지)' ($r.g1.status -eq 'ambiguous' -and $r.g2.status -eq 'ambiguous')
$script:CodexScreenCache = @{}
$script:CodexScreenReader = { param($a) if ($a -eq 'g1') { $pA } else { '' } }              # 한 창만 맞고 다른 창은 화면이 비어 있음
$r = Get-CodexPairs @{ g1 = (New-Term $fresh 30 $gc); g2 = (New-Term $fresh 30 $gc) }
Check '화면 대조: 맞는 창만 확정하고 화면이 비어 있는 창은 모호함 유지' ($r.g1.status -eq 'ok' -and $r.g1.id -eq $idX1 -and $r.g2.status -eq 'ambiguous')
$script:CodexScreenCache = @{}
$script:CodexScreenReader = { param($a) '공통 안내문 같은 줄 같은 줄 같은 줄 AGENTS.md instructions' }   # 모든 대화에 있는 안내문은 근거로 쓰지 않는다
$r = Get-CodexPairs @{ g1 = (New-Term $fresh 30 $gc); g2 = (New-Term $fresh 30 $gc) }
Check '화면 대조: 안내문(AGENTS.md)만 보이면 확정하지 않음' ($r.g1.status -eq 'ambiguous' -and $r.g2.status -eq 'ambiguous')
$script:CodexScreenCache = @{}
$script:CodexScreenReader = { param($a) throw '읽기 실패' }                                    # hc read 가 실패해도 예외 없이 모호함 유지
$r = Get-CodexPairs @{ g1 = (New-Term $fresh 30 $gc); g2 = (New-Term $fresh 30 $gc) }
Check '화면을 못 읽어도 예외 없이 모호함 유지' ($r.g1.status -eq 'ambiguous' -and $r.g2.status -eq 'ambiguous')
$idX3 = '01a1c000-0000-7000-8000-0000000000a3'                                               # 방금 /new 한 대화: 발화가 없어 화면과 대조할 수 없다
$null = New-ChatRollout $idX3 @()
$script:CodexSigCache = @{}; $script:CodexScreenCache = @{}
$script:CodexScreenReader = { param($a) if ($a -eq 'g1') { $pA } else { $pB } }
$r = Get-CodexPairs @{ g1 = (New-Term $fresh 30 $gc); g2 = (New-Term $fresh 30 $gc) }
Check '화면 대조: 대조할 수 없는 후보(방금 /new)가 있으면 옛 대화로 확정하지 않는다' ($r.g1.status -eq 'ambiguous' -and $r.g2.status -eq 'ambiguous')
Remove-Item (Join-Path $tmp "rollout-2026-11-11T00-00-00-$idX3.jsonl") -Force
$script:CodexSigCache = @{}; $script:CodexScreenCache = @{}
Check '탐색 폴더: 시험이 폴더를 바꾸면 실제 Codex 폴더는 섞이지 않는다' ((@(Get-CodexSessDirList)).Count -eq 1 -and @(Get-CodexSessDirList)[0] -eq $tmp)
$script:CodexScreenReader = { param($a) '' }

Get-ChildItem $tmp -File | Remove-Item -Force
"합계: PASS $script:pass / FAIL $script:fail"
if ($script:fail) { exit 1 }
