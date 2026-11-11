# herdr-launch.ps1 - Herdr 를 켜기 전에 새 버전이 받아져 있으면 먼저 적용하고 앱을 올린다(herdr-launch.vbs 가 숨김으로 부른다).
# 실패해도 앱은 켠다. 끄기: session-keeper.ps1 -Mode Update -Auto Off / 런처 해제: -Mode Update -Launcher Uninstall
$ErrorActionPreference = 'Continue'
try {
    $env:KEEPER_NO_MAIN = '1'                       # 키퍼의 함수만 불러온다(감시를 시작하지 않는다)
    . (Join-Path $PSScriptRoot 'session-keeper.ps1')
    Remove-Item Env:KEEPER_NO_MAIN -ErrorAction SilentlyContinue      # 앱이 이 값을 물려받으면 안 된다(복구 창 버튼이 띄우는 키퍼가 아무것도 안 하게 됨)
    Invoke-HerdrLaunch
} catch {
    Remove-Item Env:KEEPER_NO_MAIN -ErrorAction SilentlyContinue
    try { Add-Content -Path (Join-Path $PSScriptRoot 'session-keeper.log') -Value ("{0:yyyy-MM-dd HH:mm:ss} 런처 실패(vbs 가 앱을 직접 켭니다): {1}" -f (Get-Date), $_.Exception.Message) -Encoding UTF8 } catch {}
}
