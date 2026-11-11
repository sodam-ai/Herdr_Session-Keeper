@echo off
chcp 65001 >nul
echo Herdr Session Keeper - install
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
