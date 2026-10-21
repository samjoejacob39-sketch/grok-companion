@echo off
rem -- Shinchan Helper - 24/7 local host watchdog --
rem 1) If the port is already held by another instance, wait (no double runs).
rem 2) If the server crashes, node exits and this loop restarts it in 5s.
title Shinchan Helper - 24/7 host
cd /d "%~dp0"
set PORT=6767
set HOST=127.0.0.1

:loop
netstat -ano | findstr /i "TCP.*:6767.*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo port 6767 busy - an instance is already hosting, waiting 60s...
  timeout /t 60 /nobreak >nul
  goto loop
)
node server/index.js
echo server exited, restarting in 5s...
timeout /t 5 /nobreak >nul
goto loop
