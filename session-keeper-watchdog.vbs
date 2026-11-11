' session-keeper-watchdog.vbs - Herdr 앱이 켜져 있을 때만 session-keeper 를 켜 준다(PC 부팅만으로는 켜지 않는다).
' Windows 작업 스케줄러가 1분마다 호출한다.
'   - Herdr 앱(herdr-app.exe)이 꺼져 있으면 아무것도 하지 않는다.
'   - 앱이 켜져 있고 session-keeper 가 살아 있으면(심박 파일이 3분 안에 갱신됨) 아무것도 하지 않는다.
'   - 앱이 켜져 있는데 session-keeper 가 없으면 켠다(=Herdr 를 켠 뒤 최대 1분 안에 복구가 시작된다).
' 이미 실행 중인데 중복 호출돼도 session-keeper 의 잠금(mutex)이 새 프로세스를 조용히 종료시킨다.
' 시험용: 인자 1 = 앱 프로세스 이름(기본 herdr-app.exe), 환경변수 HERDR_WATCHDOG_DRY=1 이면 켜지 않고 결과만 출력(cscript 로 실행).
Option Explicit
Dim fso, aliveFile, shell, procName, dry, keeperPs1, cmd
' 경로는 이 파일이 있는 폴더 기준이다(폴더를 옮기거나 다른 PC 에 설치해도 그대로 동작).
Set fso = CreateObject("Scripting.FileSystemObject")
keeperPs1 = fso.GetParentFolderName(WScript.ScriptFullName) & "\session-keeper.ps1"
aliveFile = fso.GetParentFolderName(WScript.ScriptFullName) & "\session-keeper.alive"
procName = "herdr-app.exe"
If WScript.Arguments.Count > 0 Then procName = WScript.Arguments(0)
Set shell = CreateObject("WScript.Shell")
Dim aliveOverride
aliveOverride = shell.ExpandEnvironmentStrings("%HERDR_WATCHDOG_ALIVE%")   ' 시험용: 심박 파일 경로 바꿈(미설정이면 %...% 그대로 남음)
If aliveOverride <> "%HERDR_WATCHDOG_ALIVE%" And aliveOverride <> "" Then aliveFile = aliveOverride
dry = (shell.ExpandEnvironmentStrings("%HERDR_WATCHDOG_DRY%") = "1")

' 1) Herdr 앱이 떠 있는가
Dim wmi, procs
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = '" & Replace(procName, "'", "") & "'")
If procs.Count = 0 Then
    If dry Then WScript.Echo "SKIP-APP-DOWN"
    WScript.Quit 0
End If

' 2) session-keeper 가 이미 살아 있는가
Set fso = CreateObject("Scripting.FileSystemObject")
If fso.FileExists(aliveFile) Then
    If DateDiff("s", fso.GetFile(aliveFile).DateLastModified, Now) < 180 Then
        If dry Then WScript.Echo "SKIP-ALIVE"
        WScript.Quit 0
    End If
End If
If Not fso.FileExists(keeperPs1) Then WScript.Quit 1

' 3) 켠다
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & keeperPs1 & """ -Mode Run"
If dry Then
    WScript.Echo "WOULD-START"
    WScript.Quit 0
End If
shell.Run cmd, 0, False
