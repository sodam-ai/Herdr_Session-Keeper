---
name: herdr-session-keeper
description: Herdr 세션키퍼(AI 세션 복구 모드 + Herdr 앱 자동 업데이트)를 이 PC 에 설치·점검·업데이트·제거할 때 사용. "세션키퍼 설치", "Herdr 세션 복구 설치", "Herdr 업데이트가 안 돼" 같은 요청에 해당.
---

# Herdr 세션키퍼 설치 도우미

이 스킬은 **설치 스크립트를 실행해 주는 안내서**입니다. 실제 설치 프로그램은 이 플러그인 폴더에 들어 있습니다.

## 1. 위치 찾기
- 이 스킬이 로드될 때 알려 주는 "Base directory for this skill" 에서 **두 단계 위**(`..\..`)가 플러그인 폴더입니다. 그 안에 `install.ps1`, `uninstall.ps1`, `payload\` 가 있습니다.
- 환경변수 `CLAUDE_PLUGIN_ROOT` 가 있으면 그 폴더와 같은 곳입니다. 두 방법으로 `install.ps1` 이 확인되지 않으면 설치하지 말고 사용자에게 알리세요.

## 2. 순서 (반드시 이 순서, 각 단계 결과를 사용자에게 쉬운 말로 전달)
1. **점검만 먼저**: `powershell -NoProfile -ExecutionPolicy Bypass -File "<플러그인 폴더>\install.ps1" -Check`
   - Node.js 18+, Herdr 앱, 설정 폴더, 다른 위치의 기존 세션키퍼 유무를 확인합니다. 아무것도 바꾸지 않습니다.
   - "중단:" 으로 끝나면 이유를 그대로 전하고 멈춥니다(임의로 `-Force` 를 붙이지 않습니다).
2. **사용자에게 확인**: 설치하면 바뀌는 것(아래 "바뀌는 것")을 알리고 진행 여부를 묻습니다.
3. **설치**: 같은 명령에서 `-Check` 만 뺍니다. 옵션: `-InstallDir` `-HerdrHome` `-HerdrApp` `-NoTask`(자동 실행 작업 안 만듦) `-NoKey` `-Launcher`(바로가기 연결, 선택) `-RestartKeeper` `-Force`(다른 위치 설치 교체).
4. **확인**: 설치 끝 메시지, Herdr 에서 `Ctrl+Shift+R` 로 세션키퍼 창이 열리는지(안 되면 `Ctrl+Shift+P` → `mod.open session-keeper`).

## 바뀌는 것 (설치 전에 사용자에게 알릴 것)
- 프로그램 파일: `%LOCALAPPDATA%\HerdrSessionKeeper\app` (기본)
- Herdr 모드: `<Herdr 설정 폴더>\mods\session-keeper` + `keys.json` 에 `Ctrl+Shift+R` 한 줄(원본 백업 자동 생성)
- Windows 작업 스케줄러에 `HerdrSessionKeeper-Watchdog` (Herdr 가 켜져 있을 때만 1분마다 감시를 켬)
- Herdr 앱·터미널·Claude/Codex 대화 기록은 건드리지 않습니다. 관리자 권한 불필요.

## 자주 쓰는 다른 작업
- **제거**: `uninstall.ps1` (데이터까지 지우려면 `-RemoveData`)
- **Herdr 앱 자동 업데이트 끄기/켜기/상태**: `powershell -File "<설치 위치>\session-keeper.ps1" -Mode Update -Auto Off|On|Status`
- **Herdr 앱 업데이트 지금 적용**(창만 껐다 켬, 터미널은 유지): 같은 명령에 `-Mode Update` 만. **창이 한 번 닫혔다 열리므로 사용자 동의 후에만** 실행합니다.

## 주의
- Windows 전용. Node.js 18+ 필요(없으면 https://nodejs.org 의 LTS 설치 파일을 안내).
- 설치/제거 스크립트가 실패하면 출력 그대로 전하고, 파일을 직접 고치거나 가드를 우회하지 마세요.
