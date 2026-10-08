param([string]$PackageDirectory = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$directory = (Resolve-Path -LiteralPath $PackageDirectory).Path
$executable = Join-Path $directory 'Banguru.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Extract the complete Banguru package first.' }
$path = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Banguru.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($path)
$shortcut.TargetPath = $executable
$shortcut.WorkingDirectory = $directory
$shortcut.Description = 'Banguru'
$shortcut.IconLocation = "$executable,0"
$shortcut.Save()
Write-Output "Banguru desktop shortcut: $path"
