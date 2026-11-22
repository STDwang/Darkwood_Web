@echo off
setlocal
cd /d "%~dp0"
title Blackwood Ember

set "GAME=%~dp0Blackwood_Ember.html"

rem  Double-click to play. Pass --rebuild (or run rebuild.bat) after code changes.
if /i "%~1"=="--rebuild" goto build
if exist "%GAME%" goto run

:build
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Node.js was not found. It is only needed ONCE to build the game.
  echo      Install Node.js 20+ from https://nodejs.org and double-click again.
  echo.
  pause
  exit /b 1
)

if exist "node_modules\vite\bin\vite.js" goto dobuild
echo  First run: installing dependencies, please wait...
where npm >nul 2>nul
if errorlevel 1 (
  echo  [!] npm was not found. Install Node.js 20+ from https://nodejs.org
  pause
  exit /b 1
)
call npm install --no-audit --no-fund
if errorlevel 1 goto fail

:dobuild
echo  Building single-file game, please wait...
if exist "%GAME%" del /q "%GAME%"
node "node_modules\vite\bin\vite.js" build --mode single > "%~dp0build_log.txt" 2>&1
if errorlevel 1 (
  type "%~dp0build_log.txt"
  goto fail
)
if not exist "%GAME%" goto fail

:run
start "" "%GAME%"
exit /b 0

:fail
echo.
echo  [!] Build failed. Copy the error above and send it to your assistant.
echo.
pause
exit /b 1
