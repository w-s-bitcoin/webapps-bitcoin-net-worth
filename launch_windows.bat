@echo off
setlocal

set "SCRIPT_DIR=%~dp0"

cd /d "%SCRIPT_DIR%"

echo Starting Bitcoin Net Worth Tracker...

where powershell >nul 2>nul
if %ERRORLEVEL%==0 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%launch_windows.ps1"
  goto :eof
)

echo PowerShell was not found. Run launch_windows.ps1 manually.
pause
