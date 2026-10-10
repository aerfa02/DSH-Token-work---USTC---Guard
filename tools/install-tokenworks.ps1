param(
  [string]$TokenWorksDirectory = 'E:\TokenWorks',
  [string]$DataDirectory = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'tokenworks-electron\dsh')
)
$ErrorActionPreference = 'Stop'
$tokenRoot = [IO.Path]::GetFullPath($TokenWorksDirectory)
$tokenHome = [IO.Path]::GetFullPath($DataDirectory)
$tokenRelease = Get-Content -LiteralPath (Join-Path $tokenRoot 'release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if($tokenRelease.distribution -ne 'tokenworks') { throw 'Target is not TokenWorks' }
$tokenProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($tokenRoot.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) })
if($tokenProcesses.Count) { throw 'Save work and fully exit TokenWorks and its updater before installing' }
& (Join-Path $PSScriptRoot 'install-local.ps1') -DshDirectory $tokenRoot -ApplicationExecutable 'EduWork-Electron.exe' -PluginDirectory (Join-Path $tokenHome 'plugins') -ProfileDirectory (Join-Path $tokenHome 'profiles\desktop-017')
