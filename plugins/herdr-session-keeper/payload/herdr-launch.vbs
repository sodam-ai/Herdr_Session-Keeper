' herdr-launch.vbs - hidden launcher that Herdr shortcuts go through.
' Applies a downloaded Herdr update BEFORE the app starts (herdr-launch.ps1), then starts the app.
' Herdr must always start, so:
'  - if the launcher script is missing (moved/deleted/drive not mounted) the app is started directly
'  - the script is NOT waited for forever: if no Herdr process exists after 45 s the app is started directly
'  - process existence is checked with tasklist (not WMI), so a WMI failure cannot cause a double start
Option Explicit
Dim sh, fso, here, ps1, exe, i, up, ex, out
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = here & "\herdr-launch.ps1"
exe = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\herdr-app\herdr-app.exe"
sh.CurrentDirectory = sh.ExpandEnvironmentStrings("%USERPROFILE%")

Function AppRunning()
  Dim e, o
  AppRunning = False
  On Error Resume Next
  Set e = sh.Exec("cmd.exe /c tasklist /FI ""IMAGENAME eq herdr-app.exe"" /NH")
  o = e.StdOut.ReadAll
  If InStr(1, o, "herdr-app.exe", 1) > 0 Then AppRunning = True
  On Error GoTo 0
End Function

If Not fso.FileExists(ps1) Then
  sh.Run """" & exe & """", 1, False
  WScript.Quit 0
End If

On Error Resume Next
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
On Error GoTo 0
up = False
For i = 1 To 90
  WScript.Sleep 500
  If AppRunning() Then
    up = True
    Exit For
  End If
Next
If Not up Then sh.Run """" & exe & """", 1, False
