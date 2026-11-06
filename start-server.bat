@echo off
chcp 65001 >nul
title PureTone 本地服务
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node 18 或更高版本。
  pause
  exit /b 1
)

rem 已有服务在跑：不重复启动，直接打开页面
netstat -ano | findstr ":8787" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo [提示] PureTone 已在运行。
  if /i not "%~1"=="/nobrowser" start "" http://127.0.0.1:8787
  ping -n 2 127.0.0.1 >nul
  exit /b 0
)

echo 正在启动 PureTone 本地服务...
echo 说明：服务窗口会单独打开；日志在那个窗口里看，关闭那个窗口即停止服务。
start "PureTone Server" cmd /k node server/index.js

rem 轮询健康检查，最多等 10 秒
set /a tries=0
:waitup
ping -n 2 127.0.0.1 >nul
curl -s http://127.0.0.1:8787/api/health >nul 2>nul
if not errorlevel 1 goto opened
set /a tries+=1
if %tries% lss 10 goto waitup
echo [警告] 10 秒内未能确认服务就绪，可手动打开 http://127.0.0.1:8787
ping -n 2 127.0.0.1 >nul
exit /b 1

:opened
if /i not "%~1"=="/nobrowser" start "" http://127.0.0.1:8787
echo 完成：浏览器已打开 http://127.0.0.1:8787
ping -n 2 127.0.0.1 >nul
