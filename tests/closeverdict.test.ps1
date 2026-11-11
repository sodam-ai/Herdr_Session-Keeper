# 직접 닫은 창 판정(Get-CloseVerdict)과 "닫히기 직전" 자동 복구 필터(Get-RecentCutoff/Test-RecentEntry) 시험. hc/Herdr 를 쓰지 않는다.
# 마지막 줄 "합계: PASS n / FAIL m" 형식은 run-all 이 읽는다.
$env:KEEPER_NO_MAIN = '1'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'session-keeper.ps1')
$script:pass = 0; $script:fail = 0
function Check([string]$n, $c) { if ($c) { $script:pass++; "PASS  $n" } else { $script:fail++; "FAIL  $n" } }
$killed = [pscustomobject]@{ state = 'finished'; reason = 'killed'; exit_code = 1; finished_ms = 1 }

# 1) 직접 닫음 판정
Check '직접 닫음: 종료 기록 killed + 다른 창이 살아 있음 -> user' ((Get-CloseVerdict $killed 5) -eq 'user')
Check '살아 있는 창이 0개(앱 전체 종료 중) -> keep' ((Get-CloseVerdict $killed 0) -eq 'keep')
Check '종료 기록 조회 불가(코어가 새로 뜸) -> keep' ((Get-CloseVerdict $null 5) -eq 'keep')
Check "killed 가 아닌 종료(exited) -> keep" ((Get-CloseVerdict ([pscustomobject]@{ state = 'finished'; reason = 'exited'; exit_code = 0 }) 5) -eq 'keep')
Check '아직 live 상태 기록 -> keep' ((Get-CloseVerdict ([pscustomobject]@{ state = 'live'; reason = '' }) 5) -eq 'keep')
Check '이상한 입력(필드 없음)도 예외 없이 keep' ((Get-CloseVerdict ([pscustomobject]@{}) 3) -eq 'keep')

# 2) 닫히기 직전 필터
$t = { param($min) (Get-Date '2026-11-10T21:55:00').AddMinutes(-$min).ToString('yyyy-MM-ddTHH:mm:ss') }
$old = [pscustomobject]@{ addr = 'told'; seen = (& $t 3000) }      # 예전에 직접 닫은 창
$a = [pscustomobject]@{ addr = 'ta'; seen = (& $t 0) }             # 닫히는 순간 열려 있던 창
$b = [pscustomobject]@{ addr = 'tb'; seen = (& $t 4) }             # 4분 전까지 확인된 창(같은 사건)
$c = [pscustomobject]@{ addr = 'tc'; seen = (& $t 40) }            # 40분 전에 닫힌 창
$pend = @($old, $a, $b, $c)
$cut = Get-RecentCutoff $pend 10
Check '기준 시각 = 가장 늦게 확인된 시각 - 10분' ($cut -eq (Get-Date '2026-11-10T21:45:00'))
$rec = @($pend | Where-Object { Test-RecentEntry $_ $cut } | ForEach-Object { $_.addr })
Check '닫히기 직전 창(ta, tb)만 남고 예전 창(told, tc)은 제외' (($rec -join ',') -eq 'ta,tb')
Check '경계: 기준 시각과 정확히 같은 창은 포함' (Test-RecentEntry ([pscustomobject]@{ seen = '2026-11-10T21:45:00' }) $cut)
Check '기준이 $null 이면 전부 포함' ((@($pend | Where-Object { Test-RecentEntry $_ $null })).Count -eq 4)
Check 'seen 을 읽을 수 없는 항목은 빠뜨리지 않고 포함' ((Test-RecentEntry ([pscustomobject]@{ addr = 'x'; seen = '쓰레기' }) $cut) -and (Test-RecentEntry ([pscustomobject]@{ addr = 'y' }) $cut))
Check '읽을 수 있는 시각이 하나도 없으면 기준 $null' ($null -eq (Get-RecentCutoff @([pscustomobject]@{ addr = 'x'; seen = '쓰레기' }, [pscustomobject]@{ addr = 'y' }) 10))
Check '빈 목록·$null 입력도 안전' (($null -eq (Get-RecentCutoff @() 10)) -and ($null -eq (Get-RecentCutoff $null 10)))
# 3) 실제 기록(읽기 전용): 예외 없이 계산되고 대상이 1개 이상 남는다
# 이 PC 의 실제 기록(읽기 전용)이 있으면 그것을, 없으면(저장소를 새로 받은 PC) 가짜 기록을 쓴다
$mapPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'session-map.json'
if (Test-Path -LiteralPath $mapPath) { $real = Get-Content $mapPath -Raw -Encoding UTF8 | ConvertFrom-Json }
else {
    $nowIso = (Get-Date).ToString('o')
    $real = [pscustomobject]@{
        t1 = [pscustomobject]@{ addr = 't1'; where = '프로젝트 / alpha'; space = '프로젝트'; tab = 'alpha'; sid = '11111111-1111-4111-8111-111111111111'; cwd = 'C:\work\alpha'; seen = $nowIso }
        t2 = [pscustomobject]@{ addr = 't2'; where = '프로젝트 / beta'; space = '프로젝트'; tab = 'beta'; sid = '22222222-2222-4222-8222-222222222222'; cwd = 'C:\work\beta'; seen = $nowIso }
        t3 = [pscustomobject]@{ addr = 't3'; where = '기타 / gamma'; space = '기타'; tab = 'gamma'; sid = '33333333-3333-4333-8333-333333333333'; cwd = 'C:\work\gamma'; seen = $nowIso }
        t4 = [pscustomobject]@{ addr = 't4'; where = '기타 / delta'; space = '기타'; tab = 'delta'; sid = '44444444-4444-4444-8444-444444444444'; cwd = 'C:\work\delta'; seen = $nowIso }
    }
}
$ents = @($real.PSObject.Properties | ForEach-Object { $_.Value })
$cut2 = Get-RecentCutoff $ents 10
$n2 = @($ents | Where-Object { Test-RecentEntry $_ $cut2 }).Count
Check "실제 기록 $($ents.Count)개: 기준 시각 계산, 대상 $n2 개(1개 이상, 전체 이하)" ($null -ne $cut2 -and $n2 -ge 1 -and $n2 -le $ents.Count)
"합계: PASS $script:pass / FAIL $script:fail"
if ($script:fail -gt 0) { exit 1 }
