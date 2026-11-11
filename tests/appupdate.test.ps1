# Herdr 앱 업데이트 시험 1: 버전 판정, 근본 원인 재현(작업 폴더로 잡힌 폴더), 파일 교체, 창 재시작, 중간 실패 원복.
# 가짜 herdr-app.exe 와 임시 폴더만 쓴다(hc ls 읽기만 한다). 마지막 줄 "합계: PASS n / FAIL m" 형식은 run-all 이 읽는다.
. (Join-Path $PSScriptRoot 'appupdate-common.ps1')

# 1) 버전 읽기 / 받아 둔 새 버전 검증
$i1 = New-Install 'a1' $false
$env:KEEPER_APP_DIR = $i1
Check 'exe 버전 읽기: 0.1.14' ((Get-ExeVersion (Join-Path $i1 'herdr-app.exe')) -eq '0.1.14')
Check '없는 파일 -> $null' ($null -eq (Get-ExeVersion (Join-Path $T 'nope.exe')))
Check '새 버전 폴더 없음 -> 할 일 없음(none)' ((Get-AppUpdateState).kind -eq 'none')
$i2 = New-Install 'a2' $true
$env:KEEPER_APP_DIR = $i2
$s = Get-AppUpdateState
Check '받아 둔 0.1.15 + 영수증 일치 -> ready' ($s.kind -eq 'ready' -and $s.staged -eq '0.1.15' -and $s.installed -eq '0.1.14')
$i3 = New-Install 'a3' $true '0.1.99'; $env:KEEPER_APP_DIR = $i3
Check '영수증 버전과 받은 exe 버전이 다르면 믿지 않는다(none)' ((Get-AppUpdateState).kind -eq 'none')
$i4 = New-Install 'a4' $true; Remove-Item "$i4.new.json" -Force; $env:KEEPER_APP_DIR = $i4
Check '영수증이 없으면 믿지 않는다(none)' ((Get-AppUpdateState).kind -eq 'none')

# 2) 근본 원인 재현: 작업 폴더로 잡힌 폴더는 이름을 못 바꾸고, 파일 교체는 된다
$i5 = New-Install 'a5' $true; $env:KEEPER_APP_DIR = $i5
$holder = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'ping -n 60 127.0.0.1 >nul' -WorkingDirectory $i5 -WindowStyle Minimized -PassThru
Start-Sleep -Milliseconds 800
$h = @(Get-CwdHolders $i5)
Check "설치 폴더를 작업 폴더로 잡은 프로세스를 찾는다(cmd pid $($holder.Id))" (@($h | Where-Object { $_.pid -eq $holder.Id }).Count -ge 1)
$renamed = $true; try { Rename-Item -LiteralPath $i5 -NewName 'herdr-app.old-try' -ErrorAction Stop } catch { $renamed = $false }
Check '재현: 작업 폴더로 잡힌 설치 폴더는 이름 바꾸기가 실패한다(앱 자신의 교체 방식이 막히는 이유)' (-not $renamed)
if ($renamed) { Rename-Item -LiteralPath (Join-Path $T 'a5\herdr-app.old-try') -NewName 'herdr-app' }
$run = Start-Process -FilePath (Join-Path $i5 'herdr-app.exe') -WorkingDirectory $T -WindowStyle Minimized -PassThru     # 실행 중인 옛 창
Start-Sleep -Milliseconds 800
$rc = Invoke-AppUpdate $false $false
Check '파일 교체 성공(작업 폴더 잡힘 + 옛 exe 실행 중인데도)' ($rc -eq 0)
Check '설치된 exe 가 0.1.15 로 바뀜' ((Get-ExeVersion (Join-Path $i5 'herdr-app.exe')) -eq '0.1.15')
Check '다른 파일도 교체됨(svg15)' ((Get-Content (Join-Path $i5 'herdr-app.svg') -Raw).Trim() -eq 'svg15')
Check '옛 exe 는 .old-* 로 남아 있다(실행 중이라 지울 수 없음)' (@(Get-ChildItem $i5 -Filter 'herdr-app.exe.old-*').Count -eq 1)
Check '전체 백업 폴더가 만들어짐(옛 exe 0.1.14 포함)' ((@(Get-ChildItem (Split-Path $i5) -Directory -Filter 'herdr-app.backup-0.1.14-*')).Count -eq 1)
Check '받아 둔 폴더와 영수증은 정리됨' (-not (Test-Path "$i5.new") -and -not (Test-Path "$i5.new.json"))
Check '창은 아직 옛 버전 -> 상태 restart(껐다 켜야 반영)' ((Get-AppUpdateState).kind -eq 'restart')
Stop-Process -Id $holder.Id -ErrorAction SilentlyContinue

# 3) 창 재시작: 옛 창에는 옛 exe 로 종료 신호 -> 새 exe 로 다시 뜸 (실제 hc ls 읽기만 사용)
Start-Sleep -Milliseconds 300
$oldPid = $run.Id
$rc2 = Invoke-AppUpdate $false $true
Check '창 재시작 흐름이 성공 코드로 끝남' ($rc2 -eq 0)
Check '옛 창 프로세스는 종료됨' (-not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue))
$newProc = @(Get-AppProcs $i5)[0]
if ($null -eq $newProc) { Start-Sleep -Milliseconds 700; $newProc = @(Get-AppProcs $i5)[0]; "  (진단) 첫 조회에서 못 찾아 0.7초 뒤 다시 조회: " + $(if ($newProc) { "찾음 pid $($newProc.Id)" } else { '여전히 없음. fake.log=[' + ((Get-Content (Join-Path $i5 'fake.log') -ErrorAction SilentlyContinue) -join ' ; ') + '] flag=' + (Test-Path (Join-Path $i5 'quit.flag')) + ' 키퍼로그=[' + ((Get-Content (Join-Path $kd 'session-keeper.log') -Tail 5 -ErrorAction SilentlyContinue) -join ' || ') + '] CIM 전체: ' + ((Get-CimInstance Win32_Process -Filter "Name='herdr-app.exe'" | ForEach-Object { "$($_.ProcessId):$($_.ExecutablePath)" }) -join ' | ') }) }
Check "새 창 프로세스가 떠 있다(옛 pid $oldPid, 새 pid $($newProc.Id))" ($null -ne $newProc -and $newProc.Id -ne $oldPid)
Check '재시작이 끝나면 표식은 done(짧게만 남아 키퍼 루프가 사고로 오인하지 않음), 진행 중(run) 아님' ((Get-AppUpdateMarker) -eq 'done' -and -not (Test-AppUpdateBusy) -and (Test-AppUpdateInProgress))
Check '재시작 뒤 상태 none(파일·창 모두 새 버전)' ((Get-AppUpdateState).kind -eq 'none')
Stop-Fakes

# 4) 중간 실패 -> 전부 원복(원자적이지 않다는 검증 지적 대응)
$i6 = New-Install 'a6' $true; $env:KEEPER_APP_DIR = $i6
Set-Content (Join-Path $i6 'zzz.dll') 'old-zzz'; Set-Content "$i6.new\zzz.dll" 'new-zzz'
$lock = [IO.File]::Open((Join-Path $i6 'zzz.dll'), 'Open', 'Read', 'Read')        # 읽기만 허용: 백업(읽기)은 되고 마지막 파일의 이름 바꾸기만 실패한다(exe 등은 이미 교체된 뒤)
$rc3 = Invoke-AppUpdate $false $false
$lock.Dispose()
Check '중간 실패는 실패 코드로 끝남' ($rc3 -ne 0)
Check '실패하면 exe 는 원래 버전(0.1.14)으로 원복' ((Get-ExeVersion (Join-Path $i6 'herdr-app.exe')) -eq '0.1.14')
Check '실패하면 svg 도 원래 내용으로 원복' ((Get-Content (Join-Path $i6 'herdr-app.svg') -Raw).Trim() -eq 'svg14')
Check '잠겼던 파일은 내용 그대로' ((Get-Content (Join-Path $i6 'zzz.dll') -Raw).Trim() -eq 'old-zzz')
Check '실패하면 받아 둔 새 버전은 그대로 남아 다시 시도할 수 있다' ((Test-Path "$i6.new") -and (Test-Path "$i6.new.json"))
Check '원복 뒤 .old-* 찌꺼기가 남지 않는다' (@(Get-ChildItem $i6 -Filter '*.old-*' -Recurse).Count -eq 0)
Finish-Test
