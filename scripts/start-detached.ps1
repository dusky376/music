# PureTone 开机自启引导（兼容 Windows PowerShell 5.1）
# 根目录由 $PSScriptRoot 推导（本文件在 scripts/ 下），不含任何写死绝对路径。
# 进程日志落到 logs/：server.log(stdout)、server.err.log(stderr)、autostart.log(引导记录)。
# Start-Process 不允许 stdout/stderr 重定向到同一文件，故拆成两个；启动失败时
# 引导脚本会把 stderr 汇总进 autostart.log 并写明退出码，便于一处排障。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
if (-not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

$port = if ($env:PORT) { $env:PORT } else { '8787' }
$upstream = if ($env:NETEASE_API) { $env:NETEASE_API } else { 'http://127.0.0.1:3000' }

# 精确端口匹配：Get-NetTCPConnection -LocalPort 按数值比较，不存在 :8787 命中 :87870 的问题
$listening = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if ($listening) { exit 0 }

$serverLog = Join-Path $logDir 'server.log'
$serverErr = Join-Path $logDir 'server.err.log'
$apiLog = Join-Path $logDir 'netease-api.log'
$apiErr = Join-Path $logDir 'netease-api.err.log'
$bootLog = Join-Path $logDir 'autostart.log'

$stamp = Get-Date -Format o
Add-Content -LiteralPath $bootLog -Value "[$stamp] 自启触发：PORT=$port NETEASE_API=$upstream ROOT=$root" -Encoding UTF8

# 本地网易云 API（3000）
$apiListening = Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue
if (-not $apiListening) {
  $env:HOST = '127.0.0.1'
  Start-Process node -ArgumentList 'netease-api\node_modules\NeteaseCloudMusicApi\app.js' `
    -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput $apiLog -RedirectStandardError $apiErr
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 900
    if (Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue) { break }
  }
}

# PureTone 后端：stdout -> server.log，stderr -> server.err.log
$env:NETEASE_API = $upstream
$proc = Start-Process node -ArgumentList 'server\index.js' `
  -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $serverLog -RedirectStandardError $serverErr

# 启动失败可见：等 1.5s，若进程立即退出，把退出码与 stderr 汇总进 autostart.log
Start-Sleep -Milliseconds 1500
$proc.Refresh()
if ($proc.HasExited) {
  $stamp = Get-Date -Format o
  Add-Content -LiteralPath $bootLog -Value "[$stamp] [错误] 后端进程启动后立即退出（ExitCode=$($proc.ExitCode)）。stdout 见 server.log，stderr 见 server.err.log，内容如下：" -Encoding UTF8
  if (Test-Path -LiteralPath $serverErr) {
    Add-Content -LiteralPath $bootLog -Value (Get-Content -LiteralPath $serverErr -Raw) -Encoding UTF8
  }
  exit 1
}
Add-Content -LiteralPath $bootLog -Value "[$stamp] 后端已启动（PID=$($proc.Id)），日志见 server.log。" -Encoding UTF8
