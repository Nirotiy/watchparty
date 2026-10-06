$ErrorActionPreference = 'Stop'
$env:ELECTRON_RUN_AS_NODE = $null
$desktopShell = Split-Path -Parent $PSScriptRoot
Set-Location $desktopShell

$projectMarker = 'D:\NRT-GIT\watchparty\desktop-shell\electron\'
$existing = @(Get-CimInstance Win32_Process -Filter "name='electron.exe'" | Where-Object { $_.CommandLine -like "*$projectMarker*" })
if ($existing.Count -gt 0) {
  $main = $existing | Where-Object { $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
  if ($main) {
    Write-Host "A Linkle Electron instance is already running (PID $($main.ProcessId)). Close that window and retry." -ForegroundColor Yellow
    exit 2
  }
}

Write-Host 'Building Electron pages and native sidecar...' -ForegroundColor Cyan
npm run electron:build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host 'Starting Linkle Electron. Keep this window open to view runtime output.' -ForegroundColor Green
npm --prefix electron start
exit $LASTEXITCODE
