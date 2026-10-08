[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ServerOrigin,

  [Parameter(Mandatory = $true)]
  [string]$CertificatePath,

  [string]$ElectronExecutable,

  [switch]$SkipSiteCredentials
)

$ErrorActionPreference = 'Stop'
$env:ELECTRON_RUN_AS_NODE = $null
$desktopShell = Split-Path -Parent $PSScriptRoot
$electronDirectory = Join-Path $desktopShell 'electron'

try {
  $originUri = [Uri]$ServerOrigin.Trim()
} catch {
  throw 'ServerOrigin must be a valid HTTPS origin, for example https://39.108.227.53:8443.'
}

if ($originUri.Scheme -cne 'https' -or $originUri.UserInfo -or $originUri.AbsolutePath -ne '/' -or $originUri.Query -or $originUri.Fragment) {
  throw 'ServerOrigin must contain only an HTTPS scheme, host, and optional port. Remote HTTP is not accepted.'
}

$origin = $originUri.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
$certificate = (Resolve-Path -LiteralPath $CertificatePath).Path
$certificateText = [System.IO.File]::ReadAllText($certificate)
if ($certificateText -notmatch '-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----') {
  throw 'CertificatePath must point to a PEM certificate or CA bundle.'
}

$existing = @(Get-CimInstance Win32_Process -Filter "name='electron.exe'" | Where-Object {
  $_.CommandLine -like "*$electronDirectory*"
})
if ($existing.Count -gt 0) {
  throw 'Close the running WatchParty Electron window before applying local server settings.'
}

$electronPackage = Join-Path $electronDirectory 'node_modules\electron'
if (-not (Test-Path -LiteralPath $electronPackage)) {
  throw 'The Electron package must be installed under desktop-shell/electron so the app can load its runtime APIs.'
}
if ($ElectronExecutable -and -not (Test-Path -LiteralPath $ElectronExecutable -PathType Leaf)) {
  throw "Electron executable was not found: $ElectronExecutable"
}

$arguments = @('--configure-local', "--configure-origin=$origin", "--configure-certificate=$certificate")
if (-not $SkipSiteCredentials) {
  $arguments += '--configure-site-credentials'
}

Write-Host "Saving HTTPS server settings for $origin and importing its certificate through the desktop app..." -ForegroundColor Cyan
$previousLaunchFlag = $env:WATCHPARTY_LOCAL_LAUNCH
$env:WATCHPARTY_LOCAL_LAUNCH = '1'
try {
  if ($ElectronExecutable) {
    & $ElectronExecutable $electronDirectory @arguments
  } else {
    & node (Join-Path $electronDirectory 'launch.mjs') @arguments
  }
  $exitCode = $LASTEXITCODE
} finally {
  $env:WATCHPARTY_LOCAL_LAUNCH = $previousLaunchFlag
}

if ($exitCode -ne 0) {
  throw "Desktop configuration failed with exit code $exitCode. Review the native error code above."
}

Write-Host "Saved server origin and origin-scoped certificate for $origin." -ForegroundColor Green
if ($SkipSiteCredentials) {
  Write-Host 'Site Basic Auth credentials were left unchanged. Set them in Settings > Security & Advanced.' -ForegroundColor Yellow
} else {
  Write-Host 'Complete the Windows credential prompt if it appeared. Cancel leaves credentials unchanged.' -ForegroundColor Yellow
}
