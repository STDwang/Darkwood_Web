@echo off
setlocal
cd /d "%~dp0"
title Blackwood Ember - checks
set "LOG=%~dp0check_log.txt"
echo ==== Blackwood Ember checks %date% %time% ==== > "%LOG%"
echo  Running checks. Results are written to check_log.txt (your assistant reads it).
echo.

echo  [1/5] Type check...
echo. >> "%LOG%"
echo ===== [1/5] TYPECHECK tsc --noEmit ===== >> "%LOG%"
node "node_modules\typescript\bin\tsc" --noEmit >> "%LOG%" 2>&1
echo EXIT=%errorlevel% >> "%LOG%"

echo  [2/5] Simulation check...
echo. >> "%LOG%"
echo ===== [2/5] SIM-CHECK ===== >> "%LOG%"
call "node_modules\.bin\tsx.cmd" tools\checks\sim-check.ts >> "%LOG%" 2>&1
echo EXIT=%errorlevel% >> "%LOG%"

echo  [3/5] Building single-file game...
echo. >> "%LOG%"
echo ===== [3/5] BUILD ===== >> "%LOG%"
node "node_modules\vite\bin\vite.js" build --mode single >> "%LOG%" 2>&1
echo EXIT=%errorlevel% >> "%LOG%"

echo  [4/5] Smoke check (headless Chrome)...
echo. >> "%LOG%"
echo ===== [4/5] SMOKE ===== >> "%LOG%"
node tools\checks\smoke-check.mjs >> "%LOG%" 2>&1
echo EXIT=%errorlevel% >> "%LOG%"

echo  [5/5] Palette check (headless Chrome)...
echo. >> "%LOG%"
echo ===== [5/5] PALETTE ===== >> "%LOG%"
node tools\checks\palette-check.mjs >> "%LOG%" 2>&1
echo EXIT=%errorlevel% >> "%LOG%"

echo. >> "%LOG%"
echo ==== done %date% %time% ==== >> "%LOG%"
echo.
echo  Done. Tell your assistant "check finished".
pause
