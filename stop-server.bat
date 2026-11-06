@echo off
chcp 65001 >nul
title 停止 PureTone 服务
rem 找到监听 8787 的进程并结束
set found=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
  set found=1
  echo 正在结束进程 PID %%a
  taskkill /PID %%a /F >nul 2>nul
)
if %found%==0 (
  echo 当前没有 PureTone 服务在运行。
) else (
  echo 已停止。
)
ping -n 2 127.0.0.1 >nul
