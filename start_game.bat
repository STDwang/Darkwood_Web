@echo off
setlocal
cd /d "%~dp0"
title Blackwood Ember

set "GAME=%~dp0Blackwood_Ember.html"

rem  Usage: double-click to play. Pass --rebuild (or run rebuild.bat) after code changes.
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

if not exist "node_modules\vite\package.json" (
  echo  First run: installing dependencies, please wait...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto fail
)

echo  Building single-file game, please wait...
call npm run build:single
if errorlevel 1 goto fail
if not exist "%GAME%" goto fail

:run
start "" "%GAME%"
exit /b 0

:fail
echo.
echo  [!] Build failed. Scroll up for the error, or send it to your assistant.
echo.
pause
exit /b 1
