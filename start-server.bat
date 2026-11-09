@echo off
chcp 65001 >nul
setlocal
title PureTone 本地服务
cd /d "%~dp0"

rem 端口与上游配置（与 server/config.js 默认值一致，支持环境变量覆盖）：
rem   PORT        后端监听端口，默认 8787
rem   API_PORT    本地网易云 API 端口，默认 3000
rem   NETEASE_API 后端上游地址，默认 http://127.0.0.1:3000
if not defined API_PORT set "API_PORT=3000"
if not defined PORT set "PORT=8787"
if not defined NETEASE_API set "NETEASE_API=http://127.0.0.1:%API_PORT%"

rem Node 版本校验：只查 node 存在不够，必须校验主版本 >= 18。
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node 18 或更高版本。
  pause
  exit /b 1
)
set "NODE_MAJOR="
for /f "tokens=1 delims=." %%v in ('node -v 2^>nul') do set "NODE_MAJOR=%%v"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
rem 用 1%NODE_MAJOR% 与 118 做数值比较，空值也不会产生语法错误（1 LSS 118 为真 -> 拒绝）。
if 1%NODE_MAJOR% LSS 118 (
  echo [错误] 当前 Node 主版本为 %NODE_MAJOR%，需要 Node >= 18。
  echo        请升级 Node.js 后重试（node -v 可查看当前版本）。
  pause
  exit /b 1
)
echo [提示] Node 版本校验通过（v%NODE_MAJOR%.x）。

rem 第一步：本地网易云 API（%API_PORT%），精确匹配端口，未监听则启动。
netstat -ano | findstr /R /C:":%API_PORT% " | findstr "LISTENING" >nul
if errorlevel 1 (
  echo [提示] 启动本地网易云 API（端口 %API_PORT%）...
  start "Netease API" cmd /k "set HOST=127.0.0.1&& node netease-api\node_modules\NeteaseCloudMusicApi\app.js"
) else (
  echo [提示] 本地网易云 API 已在运行。
)

rem 轮询 API 端口就绪，最多 15 次。
set /a api_tries=0
:waitapi
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr /R /C:":%API_PORT% " | findstr "LISTENING" >nul
if not errorlevel 1 goto apiup
set /a api_tries+=1
if %api_tries% lss 15 goto waitapi
echo [错误] 本地 API（%API_PORT%）未能启动，请看 Netease API 窗口的日志。
pause
exit /b 1

:apiup
rem 第二步：PureTone 后端（%PORT%）。端口精确匹配；若已在跑，先做健康检查
rem 并校验 upstream，绝不直接开页面（防「环境变量丢失静默回退公共代理」）。
netstat -ano | findstr /R /C:":%PORT% " | findstr "LISTENING" >nul
if errorlevel 1 goto start_backend
echo [提示] 端口 %PORT% 已有服务，先做健康检查确认它指向本地上游...
call :healthcheck
if errorlevel 3 goto mismatch
if errorlevel 2 goto healthbad
if errorlevel 1 goto healthbad
goto opened

:start_backend
echo 正在启动 PureTone 本地服务（指向 %NETEASE_API%）...
echo 说明：两个服务窗口会单独打开，日志在那里看；关闭某窗口=停止对应服务。
start "PureTone Server" cmd /k "set NETEASE_API=%NETEASE_API%&& set PORT=%PORT%&& node server/index.js"

rem 轮询健康检查，最多 10 次。
set /a tries=0
:waitup
ping -n 2 127.0.0.1 >nul
call :healthcheck
if errorlevel 3 goto mismatch
if errorlevel 2 goto healthbad
if not errorlevel 1 goto opened
set /a tries+=1
if %tries% lss 10 goto waitup
echo [错误] 服务未通过健康检查（10 次），请查看 PureTone Server 窗口日志。
pause
exit /b 1

:opened
if /i not "%~1"=="/nobrowser" start "" "http://127.0.0.1:%PORT%"
echo 完成，服务已就绪 http://127.0.0.1:%PORT% （上游 %NETEASE_API%）
ping -n 2 127.0.0.1 >nul
exit /b 0

:healthbad
echo.
echo [错误] /api/health 未返回有效的 "ok":true（HTTP 非 200、超时或内容异常）。
echo        端口 %PORT% 可能被无关进程占用，或服务未正确启动。
pause
ping -n 2 127.0.0.1 >nul
exit /b 1

:mismatch
echo.
echo  ================================================================
echo   [警告] 端口 %PORT% 上的服务 upstream 与期望的本地上游不一致！
echo.
echo   期望（NETEASE_API）: %NETEASE_API%
echo   这通常意味着：该进程丢失了 NETEASE_API 环境变量，已静默回退到
echo   公共代理（踩坑日志记录的故障），音源可能不可用或不可信。
echo   建议先运行 stop-server.bat 停止它，再重新执行 start-server.bat。
echo  ================================================================
set /p "ANS=仍要忽略警告并打开页面吗？[y/N]: "
if /i "%ANS%"=="y" goto opened
echo 已取消，未打开页面。
ping -n 2 127.0.0.1 >nul
exit /b 1

rem ---------- 子程序：执行一次健康检查 ----------
rem 依赖curl 的 -f 判 HTTP 200、--max-time 3 限时；再用 Node 解析 JSON 与 upstream。
rem exit /b 码：0=通过；1=curl 失败(HTTP 非 200/超时/连不上)；
rem             2=响应缺少 ok:true 或 JSON 非法；3=upstream 与期望不一致。
:healthcheck
set "HEALTH_FILE=%TEMP%\puretone-health-%RANDOM%.tmp"
curl -fsS --max-time 3 -o "%HEALTH_FILE%" "http://127.0.0.1:%PORT%/api/health" >nul 2>nul
if errorlevel 1 (
  del "%HEALTH_FILE%" >nul 2>nul
  exit /b 1
)
node "%~dp0scripts\healthcheck.mjs" "%HEALTH_FILE%" "%NETEASE_API%"
set "HC_RC=%errorlevel%"
del "%HEALTH_FILE%" >nul 2>nul
exit /b %HC_RC%
