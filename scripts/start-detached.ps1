# PureTone detached bootstrap (PowerShell)
# Starts local Netease API (3000) and PureTone backend (8787) as hidden processes.
# Idempotent: exits early when 8787 is already listening.
$music = 'E:\workspace\music'
$listening = Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue
if ($listening) { exit 0 }

$apiListening = Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue
if (-not $apiListening) {
  $env:HOST = '127.0.0.1'
  Start-Process node -ArgumentList 'netease-api\node_modules\NeteaseCloudMusicApi\app.js' -WorkingDirectory $music -WindowStyle Hidden
  # wait until 3000 is listening (max ~20s)
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 900
    $apiListening = Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue
    if ($apiListening) { break }
  }
}

$env:NETEASE_API = 'http://127.0.0.1:3000'
Start-Process node -ArgumentList 'server\index.js' -WorkingDirectory $music -WindowStyle Hidden
