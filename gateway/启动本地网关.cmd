@echo off
chcp 65001 >nul

powershell.exe ^
  -NoLogo ^
  -NoProfile ^
  -ExecutionPolicy Bypass ^
  -File "%~dp0启动本地网关.ps1"

if errorlevel 1 (
    echo.
    echo 本地网关启动失败，请查看上方错误信息。
    pause
)