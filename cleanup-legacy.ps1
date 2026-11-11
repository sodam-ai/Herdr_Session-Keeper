# cleanup-legacy.ps1 - 세션키퍼 개발 중 만들었다가 쓰지 않게 된 파일을 정리한다.
# 기본은 "미리보기"다: 아무것도 지우지 않고 무엇을 지울지만 보여 준다.
#
#   미리보기:   powershell -File cleanup-legacy.ps1
#   실제 삭제:  powershell -File cleanup-legacy.ps1 -Apply
#   옛 별도 창까지 지우기:  powershell -File cleanup-legacy.ps1 -Apply -LegacyPicker
#
# 지우는 것
#   1) sid-statusline.mjs, apply-sid-statusline.ps1 - 상태줄에 세션 ID 를 붙이려던 폐기된 시도(ClaudeTower 를 건드리는 방식이라 사용자가 거절).
#      apply-sid-statusline.ps1 은 실행하면 설정을 바꾸므로 남겨 두면 위험하다.
#   2) settings.json.bak-before-sid-statusline - 그때 만든 설정 백업. 지금 설정 파일과 "내용이 완전히 같을 때만" 지운다(다르면 보관하고 알려 준다).
#   3) -LegacyPicker 를 줄 때만: session-picker.ps1, Herdr-Session-Picker.vbs - 세션키퍼 창으로 대체된 옛 Windows 별도 창.
# 지우지 않는 것: 폴더, 와일드카드로 찾은 파일, 이 목록에 없는 모든 것. (파일 이름을 하나씩 지정해서만 지운다)
param(
    [switch]$Apply,
    [switch]$LegacyPicker,
    [string]$ToolDir = (Split-Path -Parent $MyInvocation.MyCommand.Path),
    [string]$SettingsFiles = ''      # 시험용: 설정 파일 경로들을 세미콜론(;)으로 이어서 지정. 비우면 실제 설정 위치 2곳
)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$settingsList = @($SettingsFiles -split ';' | Where-Object { $_.Trim() })
if ($settingsList.Count -eq 0) { $settingsList = @((Join-Path $env:APPDATA 'claude-code\settings.json'), (Join-Path $env:USERPROFILE '.claude\settings.json')) }

$script:planned = 0; $script:removed = 0; $script:kept = 0
function Remove-One([string]$path, [string]$why) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Write-Host "  없음      $path"; return }
    if (-not $Apply) { Write-Host "  지울 예정 $path   ($why)"; $script:planned++; return }
    try { Remove-Item -LiteralPath $path -Force -ErrorAction Stop; Write-Host "  삭제함    $path"; $script:removed++ }
    catch { Write-Host "  삭제 실패 $path : $($_.Exception.Message)" }
}

Write-Host ($(if ($Apply) { '[실제 삭제 모드]' } else { '[미리보기 - 아무것도 지우지 않습니다. 지우려면 -Apply 를 붙이세요]' }))
Write-Host "`n1) 폐기된 상태줄 시도 파일 ($ToolDir)"
foreach ($n in 'sid-statusline.mjs', 'apply-sid-statusline.ps1') { Remove-One (Join-Path $ToolDir $n) '폐기된 상태줄 시도' }

Write-Host "`n2) 그때 만든 설정 백업 (현재 설정과 내용이 완전히 같을 때만)"
foreach ($s in $settingsList) {
    $b = "$s.bak-before-sid-statusline"
    if (-not (Test-Path -LiteralPath $b -PathType Leaf)) { Write-Host "  없음      $b"; continue }
    if (-not (Test-Path -LiteralPath $s -PathType Leaf)) { Write-Host "  보관      $b   (현재 설정 파일이 없어 비교할 수 없음)"; $script:kept++; continue }
    if ((Get-FileHash -LiteralPath $b).Hash -eq (Get-FileHash -LiteralPath $s).Hash) { Remove-One $b '현재 설정과 내용이 같은 백업' }
    else { Write-Host "  보관      $b   (현재 설정과 내용이 달라서 지우지 않음 - 직접 확인하세요)"; $script:kept++ }
}

if ($LegacyPicker) {
    Write-Host "`n3) 옛 별도 창 (세션키퍼 창으로 대체됨)"
    foreach ($n in 'session-picker.ps1', 'Herdr-Session-Picker.vbs') { Remove-One (Join-Path $ToolDir $n) '세션키퍼 창으로 대체된 옛 별도 창' }
}

Write-Host ("`n결과: " + $(if ($Apply) { "삭제 $script:removed 개" } else { "지울 예정 $script:planned 개" }) + " / 보관 $script:kept 개")
if (-not $Apply -and $script:planned -gt 0) { Write-Host '실제로 지우려면 같은 명령 끝에 -Apply 를 붙여 다시 실행하세요.' }
if ($Apply -and $LegacyPicker) { Write-Host '저장소(git)에는 옛 별도 창 삭제가 "삭제됨"으로 표시됩니다. 커밋은 직접 하세요.' }
