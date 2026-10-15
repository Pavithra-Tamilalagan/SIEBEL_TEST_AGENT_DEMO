@echo off
setlocal enabledelayedexpansion

echo [TEST] Setting up Node 22...
set PATH=C:\temp\node-extract\node-v22.11.0-win-x64;%PATH%

echo [TEST] Verifying Node version...
node --version
npm --version

cd /d "u:\Users\pt612958\WorkSpace\siebel-ui-automation"

echo [TEST] Running clean test...
call npm run test:ssj:clean

echo [TEST] Exit code: %ERRORLEVEL%
pause
