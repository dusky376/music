@echo off
rem Auto-start PureTone services (Netease API 3000 + backend 8787).
rem Safe to run repeatedly: exits immediately if 8787 is already listening.
rem Used by Task Scheduler / Startup shortcut; windowless via PowerShell.
cd /d "%~dp0"
netstat -ano | findstr ":8787" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-detached.ps1"
