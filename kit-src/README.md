# Herdr 세션키퍼 설치 꾸러미 (Windows)

Herdr 터미널 앱에 **세션키퍼**를 설치합니다.

- **세션 복구**: Herdr 창이 닫히거나 PC 가 꺼져도, 하던 Claude Code·Codex 세션을 목록에서 골라 이어서 시작합니다 (Herdr 안에서 `Ctrl+Shift+R`).
- **Herdr 앱 자동 업데이트**: Herdr 가 열려 있으면 앱 업데이트가 적용되지 않는 문제를 해결합니다. 파일만 안전하게 바꾸고(실패하면 전부 원복) 창만 껐다 켜며, 터미널은 그대로 유지됩니다. 자동 적용은 끄고 켤 수 있습니다.

필요한 것: Windows, Herdr(앱+코어) 설치됨, Node.js 18 이상. 관리자 권한은 필요 없습니다.

## 설치 방법 (둘 중 하나)

### 방법 1. Claude Code 마켓플레이스로 설치
Claude Code 에서 아래 두 줄을 차례로 입력합니다. (`<폴더>` 는 이 꾸러미 폴더의 경로, 또는 GitHub 에 올렸다면 `사용자/저장소`)

```
/plugin marketplace add <폴더>
/plugin install herdr-session-keeper@herdr-session-keeper-market
```

그다음 Claude 에게 **"세션키퍼 설치해줘"** 라고 하면 스킬이 점검 → 확인 → 설치 순서로 진행합니다.

### 방법 2. 직접 설치
`plugins\herdr-session-keeper\install.cmd` 를 더블클릭하거나 터미널에서:

```
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\herdr-session-keeper\install.ps1
```

먼저 점검만 하려면 끝에 `-Check` 를 붙입니다(아무것도 바꾸지 않음).

## 설치하면 바뀌는 것
| 무엇 | 어디 |
|---|---|
| 프로그램 파일 | `%LOCALAPPDATA%\HerdrSessionKeeper\app` (`-InstallDir` 로 변경) |
| Herdr 모드 | `<Herdr 설정 폴더>\mods\session-keeper`, `keys.json` 에 `Ctrl+Shift+R` 한 줄 (원본 백업 자동) |
| 자동 실행 | 작업 스케줄러 `HerdrSessionKeeper-Watchdog` — Herdr 가 켜져 있을 때만 1분마다 감시를 켬 (`-NoTask` 로 생략) |

Herdr 앱, 터미널, Claude/Codex 대화 기록은 건드리지 않습니다.

## 환경이 달라도 되는 이유
설치할 때 이 PC 의 `node`, Herdr 앱, `hc`, Herdr 설정 폴더, Claude 설정 폴더(`CLAUDE_CONFIG_DIR` 또는 `%APPDATA%\claude-code` 또는 `~\.claude`) 위치를 찾아 `kit.env` 에 적어 둡니다. 폴더를 옮기거나 다른 PC 에 설치해도 경로가 코드에 박혀 있지 않습니다. 설치 위치를 옮기려면 다시 설치(`-InstallDir 새위치`)한 뒤 옛 위치는 `uninstall.ps1 -InstallDir 옛위치` 로 지우세요.

## 옵션
`-InstallDir` `-HerdrHome` `-HerdrApp` `-TaskName` `-NoTask` `-NoKey` `-Launcher`(선택: Herdr 바로가기를 런처에 연결해 앱이 켜지기 전에 업데이트) `-RestartKeeper` `-Force` `-Check`

이미 다른 위치에 세션키퍼가 설치되어 있으면 덮어쓰지 않고 멈춥니다. 교체하려면 `-Force`.

## 앱 자동 업데이트 조작
```
powershell -File "<설치 위치>\session-keeper.ps1" -Mode Update -Auto Status   (상태)
powershell -File "<설치 위치>\session-keeper.ps1" -Mode Update -Auto Off      (자동 끄기)
powershell -File "<설치 위치>\session-keeper.ps1" -Mode Update -Auto On       (자동 켜기)
powershell -File "<설치 위치>\session-keeper.ps1" -Mode Update                (지금 적용: 창만 껐다 켬)
```
Herdr 의 세션키퍼 창에도 `[앱 업데이트]` `[자동 업데이트]` 버튼이 있습니다.

## 제거
```
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\herdr-session-keeper\uninstall.ps1
```
프로그램·모드·작업·키 연결을 지웁니다. 복구 대기 기록과 로그는 남기며, 모두 지우려면 `-RemoveData`.

## 알려진 한계
- Windows 전용. Herdr 가 아직 없는 PC 에서는 설치가 멈춥니다(먼저 Herdr 설치·실행).
- 업데이트 때 새 버전에서 빠진 옛 파일은 지워지지 않습니다.
- 다른 PC 에서의 설치는 아직 실제로 해 본 적이 없습니다(만든 PC 에서 임시 폴더로 설치·제거를 시험).
