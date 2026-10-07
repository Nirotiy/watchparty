# Per-minute sampler for long-play runs: records CPU seconds and working set
# of the harness-launched Chrome only (matched by its dedicated profile path).
param([string]$OutFile = "gate-43-perminute.csv")
$log = Join-Path $PSScriptRoot "results\$OutFile"
"time,chrome_cpu_seconds,chrome_working_set_mb" | Set-Content -Path $log -Encoding ascii
for ($i = 0; $i -lt 28; $i++) {
  $procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "chrome.exe" -and $_.CommandLine -like "*poc-verify-chrome*" } | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
  $alive = @($procs | Where-Object { $_ })
  if ($alive.Count -gt 0) {
    $cpu = ($alive | Measure-Object CPU -Sum).Sum
    $ws = ($alive | Measure-Object WorkingSet64 -Sum).Sum
    $line = "{0},{1},{2}" -f (Get-Date -Format "HH:mm:ss"), [math]::Round($cpu, 1), [math]::Round($ws / 1MB, 0)
  } else {
    $line = "{0},0,0" -f (Get-Date -Format "HH:mm:ss")
  }
  Add-Content -Path $log -Value $line
  Start-Sleep -Seconds 60
}
