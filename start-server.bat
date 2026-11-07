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

set "LOCAL_API=http://127.0.0.1:3000"

rem 第一步：本地网易云 API（端口 3000），未监听则启动
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if errorlevel 1 (
  echo [提示] 启动本地网易云 API（端口 3000）...
  start "Netease API" cmd /k "set HOST=127.0.0.1&& node netease-api\node_modules\NeteaseCloudMusicApi\app.js"
) else (
  echo [提示] 本地网易云 API 已在运行。
)

rem 轮询 3000 端口就绪，最多 15 次
set /a api_tries=0
:waitapi
if %api_tries% gtr 0 ping -n 2 127.0.0.1 >nul
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if not errorlevel 1 goto apiup
set /a api_tries+=1
if %api_tries% lss 15 goto waitapi
echo [错误] 本地 API（3000）未能启动，请看 Netease API 窗口的日志。
pause
exit /b 1

:apiup
rem 第二步：PureTone 后端（端口 8787），已在跑则直接开页面
netstat -ano | findstr ":8787" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo [提示] PureTone 后端已在运行。
  if /i not "%~1"=="/nobrowser" start "" http://127.0.0.1:8787
  ping -n 2 127.0.0.1 >nul
  exit /b 0
)

echo 正在启动 PureTone 本地服务（指向本地 API）...
echo 说明：两个服务窗口会单独打开，日志在那里看；关闭某窗口=停止对应服务。
start "PureTone Server" cmd /k "set NETEASE_API=%LOCAL_API%&& node server/index.js"

rem 轮询健康检查，最多 10 次
set /a tries=0
:waitup
ping -n 2 127.0.0.1 >nul
curl -s http://127.0.0.1:8787/api/health >nul 2>nul
if not errorlevel 1 goto opened
set /a tries+=1
if %tries% lss 10 goto waitup
echo [错误] 10 秒内未确认服务启动，请手动打开 http://127.0.0.1:8787
ping -n 2 127.0.0.1 >nul
exit /b 1

:opened
if /i not "%~1"=="/nobrowser" start "" http://127.0.0.1:8787
echo 完成，服务已就绪 http://127.0.0.1:8787
ping -n 2 127.0.0.1 >nul
