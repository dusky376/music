@echo off
chcp 65001 >nul
setlocal
rem 开机自启（任务计划程序 / 启动快捷方式）：windowless。
rem 端口精确匹配：已在监听则立即退出，避免重复启动。
rem 根目录完全由 %~dp0 推导，ps1 内部再用 $PSScriptRoot 推导，不含写死绝对路径。
cd /d "%~dp0"
if not defined PORT set "PORT=8787"
rem findstr /R /C:":8787 " 精确匹配端口，避免命中 :87870 等无关端口
netstat -ano | findstr /R /C:":%PORT% " | findstr "LISTENING" >nul
if not errorlevel 1 exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-detached.ps1"
