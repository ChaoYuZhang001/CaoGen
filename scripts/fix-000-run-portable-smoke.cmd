@echo off
setlocal
if "%~1"=="" goto :usage

echo This smoke installs and uninstalls the exact FIX-000 D0 on a disposable clean Windows host.
echo You must handle SmartScreen and UAC yourself. Automation will not interact with security prompts.
echo On any failure, the installed diagnostic state is preserved and the Owner flow must stop.
set "CAOGEN_FIX000_CONFIRM="
set /p CAOGEN_FIX000_CONFIRM=Type RUN-FIX-000 to continue ^(default is No^):
if not "%CAOGEN_FIX000_CONFIRM%"=="RUN-FIX-000" (
  echo Cancelled. No installer was started.
  exit /b 2
)

"%~dp0runtime\node.exe" "%~dp0FIX-000-PACKAGED-SMOKE.mjs" ^
  --artifact "%~dp0CaoGen-0.1.8-windows-x64-unsigned-preview.exe" ^
  --descriptor "%~dp0FIX-000-D0.json" ^
  --evidence-dir "%~1" ^
  --owner-authorized
exit /b %ERRORLEVEL%

:usage
echo Usage: %~nx0 "private-evidence-directory"
exit /b 64
