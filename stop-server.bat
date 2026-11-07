@echo off
chcp 65001 >nul
title 停止 PureTone 服务
cd /d "%~dp0"

set found=0
rem 先停 PureTone 后端（8787）
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
  set found=1
  echo 正在结束进程 PID %%a（PureTone 后端）
  taskkill /PID %%a /F >nul 2>nul
)
rem 再停本地网易云 API（3000）
for /f "tokens=5" %%b in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  set found=1
  echo 正在结束进程 PID %%b（本地网易云 API）
  taskkill /PID %%b /F >nul 2>nul
)
if %found%==0 (
  echo 当前没有 PureTone / 本地 API 在运行。
) else (
  echo 已停止。
)
ping -n 2 127.0.0.1 >nul
