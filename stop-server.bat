@echo off
chcp 65001 >nul
setlocal
title 停止 PureTone 服务
cd /d "%~dp0"

rem 端口配置：后端默认 8787（与 server/config.js 的 PORT 一致），
rem 本地上游默认 3000（对应 NETEASE_API=http://127.0.0.1:3000）。
rem 均可用环境变量覆盖：PORT / API_PORT。
if not defined PORT set "PORT=8787"
if not defined API_PORT set "API_PORT=3000"

set "found=0"

rem 精确匹配端口：findstr /R /C:":8787 " 利用 netstat 端口后至少一个空格，
rem 只命中 :8787，不会命中 :87870 / :18787 等无关端口，避免强杀无关进程。
rem 去掉 /F 强杀，改用 taskkill /PID x /T 温和退出，给 server/index.js 的
rem SIGTERM 优雅退出处理有机会执行。
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":%PORT% " ^| findstr "LISTENING"') do (
  set "found=1"
  echo 正在结束进程 PID %%a（PureTone 后端，端口 %PORT%）...
  taskkill /PID %%a /T >nul 2>nul
)

for /f "tokens=5" %%b in ('netstat -ano ^| findstr /R /C:":%API_PORT% " ^| findstr "LISTENING"') do (
  set "found=1"
  echo 正在结束进程 PID %%b（本地网易云 API，端口 %API_PORT%）...
  taskkill /PID %%b /T >nul 2>nul
)

if "%found%"=="0" (
  echo 当前没有 PureTone / 本地 API 在运行。
  ping -n 2 127.0.0.1 >nul
  exit /b 0
)

rem 温和退出后等待最多约 6 秒，确认端口是否已释放；不使用 /F，避免误杀。
set /a wait=0
:waitloop
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr /R /C:":%PORT% " | findstr "LISTENING" >nul
if errorlevel 1 goto stopped
set /a wait+=1
if %wait% lss 3 goto waitloop

echo.
echo [提示] 端口 %PORT% 仍在监听：进程可能未响应温和退出。
echo        为安全起见本脚本不使用 /F 强杀，请手动确认该 PID 后再结束，
echo        或稍后重新运行本脚本。查看命令：netstat -ano ^| findstr /R /C:":%PORT% "
ping -n 2 127.0.0.1 >nul
exit /b 1

:stopped
echo 已停止。
ping -n 2 127.0.0.1 >nul
exit /b 0
