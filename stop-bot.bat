@echo off
rem ── Stop Shinchan Helper (kills whatever owns port 6767) ───────────
setlocal
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /i "TCP.*:6767.*LISTENING"') do taskkill /PID %%p /F >nul 2>&1
echo stopped.
