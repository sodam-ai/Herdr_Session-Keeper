# 복구 순서 함수(Sort-RecoverOrder 등) 시험: 실제 기록(읽기 전용) + 이상한 기록. hc/Herdr 를 쓰지 않는다.
# 마지막 줄 "합계: PASS n / FAIL m" 형식은 run-all 이 읽는다.
$env:KEEPER_NO_MAIN = '1'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'session-keeper.ps1')
$script:pass = 0; $script:fail = 0
function Check([string]$n, $c) { if ($c) { $script:pass++; "PASS  $n" } else { $script:fail++; "FAIL  $n" } }
"우선순위 목록: [" + ((Get-PriorityList) -join ', ') + "]"
# 1) 실제 기록
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
$sorted = @(Sort-RecoverOrder $ents)
Check "실제 기록 $($ents.Count)개: 정렬 후 개수 그대로, 중복·누락 없음" ($sorted.Count -eq $ents.Count -and @($sorted | Select-Object -ExpandProperty addr -Unique).Count -eq @($ents | Select-Object -ExpandProperty addr -Unique).Count)
$firstNonProj = [array]::FindIndex(@($sorted | ForEach-Object { Get-EntrySpace $_ }), [Predicate[string]]{ param($s) $s -ne '프로젝트' })
$lastProj = [array]::FindLastIndex(@($sorted | ForEach-Object { Get-EntrySpace $_ }), [Predicate[string]]{ param($s) $s -eq '프로젝트' })
Check "실제 기록: '프로젝트' 공간 창이 전부 다른 공간보다 앞에 온다" ($lastProj -lt 0 -or $firstNonProj -lt 0 -or $lastProj -lt $firstNonProj)
"앞 6개 공간: " + ((@($sorted | Select-Object -First 6) | ForEach-Object { Get-EntrySpace $_ }) -join ' | ')
# 2) 같은 공간 안에서는 최근에 쓴 대화가 먼저(가짜 파일)
$tmp = Join-Path $env:TEMP ('ord-' + [guid]::NewGuid().ToString('N').Substring(0, 6)); New-Item -ItemType Directory $tmp | Out-Null
$ProjDir = $tmp
$mk = { param($sid, $minAgo) $cwd = 'C:\x\y'; $slug = $cwd -replace '[^A-Za-z0-9]', '-'; New-Item -ItemType Directory -Force (Join-Path $tmp $slug) | Out-Null; $f = Join-Path $tmp "$slug\$sid.jsonl"; Set-Content $f 'x'; (Get-Item $f).LastWriteTime = (Get-Date).AddMinutes(-$minAgo); [pscustomobject]@{ addr = "t$sid"; where = '프로젝트 / a'; space = '프로젝트'; sid = $sid; cwd = $cwd } }
$e1 = & $mk 'a1' 50; $e2 = & $mk 'a2' 5; $e3 = & $mk 'a3' 20
$o = @(Sort-RecoverOrder @($e1, $e2, $e3)) | ForEach-Object { $_.sid }
Check "같은 공간: 최근 사용 순(a2 5분 전 → a3 20분 전 → a1 50분 전)" (($o -join ',') -eq 'a2,a3,a1')
# 3) 이상한 기록: 필드 없음/null/이상한 글자 -> 예외 없이 끝, 개수 유지
$bad = @([pscustomobject]@{ addr = 't1' }, [pscustomobject]@{ addr = 't2'; where = $null; cwd = $null; sid = $null; space = $null }, [pscustomobject]@{ addr = 't3'; where = '혼자'; space = 123; cwd = 'Z:\없는\폴더'; sid = 'not-a-uuid'; tool = 'codex'; file = 'Z:\no.jsonl' }, [pscustomobject]@{ addr = 't4'; where = ('가' * 5000) + ' / x'; space = '<b>'; cwd = "C:\`"quote"; sid = 'zz' })
$err = $null; try { $r = @(Sort-RecoverOrder $bad) } catch { $err = $_.Exception.Message }
Check '이상한 기록 4개: 예외 없이 정렬, 개수 유지' (-not $err -and $r.Count -eq 4)
Check '빈 목록·$null 입력도 안전' (@(Sort-RecoverOrder @()).Count -eq 0 -and @(Sort-RecoverOrder $null).Count -eq 0)
# 4) 우선순위 파일이 없거나 깨졌을 때
$PriorityFile = Join-Path $tmp 'none.txt'
Check '우선순위 파일이 없어도 동작(최근순만)' (@(Sort-RecoverOrder @($e1, $e2)).Count -eq 2 -and ((@(Sort-RecoverOrder @($e1, $e2)) | ForEach-Object { $_.sid }) -join ',') -eq 'a2,a1')
Set-Content (Join-Path $tmp 'p.txt') ("# 주석`r`n`r`n  프로젝트  `r`n" + [char]0 + "깨진줄`r`n관제") -Encoding UTF8
$PriorityFile = Join-Path $tmp 'p.txt'
Check '우선순위 파일: 주석·빈 줄·앞뒤 공백 처리' ((Get-PriorityList)[0] -eq '프로젝트' -and (Get-PriorityList).Count -ge 2)
Get-ChildItem $tmp -Recurse -File | Remove-Item -Force
# 경로를 '...' 문자열에 넣는 함수: 유니코드 작은따옴표로도 문자열을 빠져나갈 수 없다
Check 'ConvertTo-PsSingleQuoted: 평범한 경로는 그대로' ((ConvertTo-PsSingleQuoted 'C:\work\alpha') -eq 'C:\work\alpha')
Check 'ConvertTo-PsSingleQuoted: ASCII 작은따옴표는 두 번씩' ((ConvertTo-PsSingleQuoted "a'b") -eq "a''b")
$uq = [string][char]0x2018 + [string][char]0x2019 + [string][char]0x201A + [string][char]0x201B
Check 'ConvertTo-PsSingleQuoted: ‘ ’ ‚ ‛ 도 두 번씩' ((ConvertTo-PsSingleQuoted $uq) -eq ($uq[0].ToString() * 2 + $uq[1].ToString() * 2 + $uq[2].ToString() * 2 + $uq[3].ToString() * 2))
$evil = 'x' + [char]0x2019 + '; Get-Date; ' + [char]0x2018 + 'y'
$cmdText = "Set-Location -LiteralPath '" + (ConvertTo-PsSingleQuoted $evil) + "'; "
$perr = $null; $ptok = $null; $past = [Management.Automation.Language.Parser]::ParseInput($cmdText, [ref]$ptok, [ref]$perr)
$ncmd = @($past.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] }, $true)).Count
Check '유니코드 따옴표가 든 폴더 이름으로도 명령이 하나(Set-Location)로만 해석됨' (@($perr).Count -eq 0 -and $ncmd -eq 1)
"합계: PASS $script:pass / FAIL $script:fail"

if ($script:fail -gt 0) { exit 1 }
