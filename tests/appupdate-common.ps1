# appupdate 시험 공통 준비: 임시 폴더, 키퍼 복사본(로그·상태 파일이 임시 폴더에 쌓이도록), 가짜 herdr-app.exe 두 벌(0.1.14 / 0.1.15).
# 실제 Herdr·실제 설치 폴더·실제 바로가기는 건드리지 않는다. 이 파일은 시험 파일이 점(.)으로 불러 쓴다.
$ErrorActionPreference = 'Continue'
$src = Split-Path -Parent $PSScriptRoot
$T = Join-Path $env:TEMP ("appupd-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $T -Force | Out-Null
$script:pass = 0; $script:fail = 0
function Check([string]$n, $c) { if ($c) { $script:pass++; "PASS  $n" } else { $script:fail++; "FAIL  $n" } }

$kd = Join-Path $T 'keeper'; New-Item -ItemType Directory -Path (Join-Path $kd 'lib') -Force | Out-Null
Copy-Item "$src\session-keeper.ps1" $kd; Copy-Item "$src\lib\appupdate.ps1" (Join-Path $kd 'lib'); Copy-Item "$src\herdr-launch.vbs" $kd; Copy-Item "$src\herdr-launch.ps1" $kd

# 가짜 herdr-app.exe: --version / do app.quit(종료 신호 파일을 쓴다) / status / (인자 없음) 종료 신호 파일을 기다리는 "창"
$cs = @'
using System; using System.IO; using System.Threading;
class P { static int Main(string[] a) {
  string ver = "__VER__"; string dir = Path.GetDirectoryName(System.Reflection.Assembly.GetEntryAssembly().Location);
  if (a.Length > 0 && a[0] == "--version") { Console.WriteLine("herdr-app " + ver); return 0; }
  if (a.Length > 1 && a[0] == "do" && a[1] == "app.quit") { File.WriteAllText(Path.Combine(dir, "quit.flag"), "1"); return 0; }
  if (a.Length > 0 && a[0] == "status") { Console.WriteLine("{\"errors\":[]}"); return 0; }
  string flag = Path.Combine(dir, "quit.flag"); string lg = Path.Combine(dir, "fake.log");
  try { File.AppendAllText(lg, DateTime.Now.ToString("HH:mm:ss.fff") + " start pid " + System.Diagnostics.Process.GetCurrentProcess().Id + " flagAtStart=" + File.Exists(flag) + "\n"); } catch {}
  for (int i = 0; i < 1200; i++) { if (i % 20 == 5) { try { File.AppendAllText(lg, DateTime.Now.ToString("HH:mm:ss.fff") + " alive pid " + System.Diagnostics.Process.GetCurrentProcess().Id + "\n"); } catch {} } if (File.Exists(flag)) { try { File.AppendAllText(lg, DateTime.Now.ToString("HH:mm:ss.fff") + " exit pid " + System.Diagnostics.Process.GetCurrentProcess().Id + " saw flag\n"); } catch {} for (int k = 0; k < 40 && File.Exists(flag); k++) { try { File.Delete(flag); } catch {} Thread.Sleep(50); } return 0; } Thread.Sleep(100); }
  return 0; } }
'@
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
function New-FakeExe([string]$Out, [string]$Ver) {
    $f = Join-Path $T "fake-$Ver.cs"; Set-Content -Path $f -Value $cs.Replace('__VER__', $Ver) -Encoding ASCII
    & $csc /nologo /target:exe /out:$Out $f 2>&1 | Out-Null
}
$bin14 = Join-Path $T 'bin14.exe'; $bin15 = Join-Path $T 'bin15.exe'
New-FakeExe $bin14 '0.1.14'; New-FakeExe $bin15 '0.1.15'
if (-not ((Test-Path $bin14) -and (Test-Path $bin15))) { "FAIL  가짜 exe 컴파일"; "합계: PASS 0 / FAIL 1"; exit 1 }

$env:KEEPER_NO_MAIN = '1'; $env:KEEPER_APP_LAUNCH = 'direct'; $env:KEEPER_APP_NOLAUNCH = ''
. (Join-Path $kd 'session-keeper.ps1')

# 설치 폴더 하나를 만든다(옵션: 받아 둔 새 버전 + 영수증)
function New-Install([string]$Name, [bool]$WithStage, [string]$StageVer = '0.1.15') {
    $root = Join-Path $T $Name; New-Item -ItemType Directory -Path $root -Force | Out-Null
    $inst = Join-Path $root 'herdr-app'; New-Item -ItemType Directory -Path $inst -Force | Out-Null
    Copy-Item $bin14 (Join-Path $inst 'herdr-app.exe'); Set-Content (Join-Path $inst 'herdr-app.svg') 'svg14'; Set-Content (Join-Path $inst 'LICENSE') 'lic14'
    if ($WithStage) {
        $st = "$inst.new"; New-Item -ItemType Directory -Path $st -Force | Out-Null
        Copy-Item $bin15 (Join-Path $st 'herdr-app.exe'); Set-Content (Join-Path $st 'herdr-app.svg') 'svg15'; Set-Content (Join-Path $st 'LICENSE') 'lic14'
        [IO.File]::WriteAllText("$inst.new.json", "{`"version`":`"$StageVer`"}")
    }
    return $inst
}
function Stop-Fakes { Get-CimInstance Win32_Process -Filter "Name='herdr-app.exe'" -ErrorAction SilentlyContinue | Where-Object { "$($_.ExecutablePath)" -like "$T\*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } }
function Finish-Test { Stop-Fakes; Remove-Item -LiteralPath $T -Recurse -Force -ErrorAction SilentlyContinue; "합계: PASS $script:pass / FAIL $script:fail"; if ($script:fail -gt 0) { exit 1 } }
