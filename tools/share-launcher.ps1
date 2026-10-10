param(
  [ValidateSet('Install')][string]$Mode = 'Install',
  [string]$DshDirectory,
  [string]$ProfileDirectory
)
$ErrorActionPreference = 'Stop'
try {
  if (-not $DshDirectory) {
    $candidates = @('E:\dsh', (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'), (Join-Path $env:ProgramFiles 'DeepSeek Harness'))
    $found = $candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'DeepSeek Harness.exe') } | Select-Object -First 1
    $answer = Read-Host "DSH folder (Enter = $found)"
    $DshDirectory = if ($answer) { $answer.Trim('"') } else { $found }
  }
  if (-not $DshDirectory) { throw 'Please enter the folder containing DeepSeek Harness.exe' }
  $DshDirectory = [IO.Path]::GetFullPath($DshDirectory)
  $exe = Join-Path $DshDirectory 'DeepSeek Harness.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'DeepSeek Harness.exe not found in selected folder' }
  if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) { throw 'Exit DSH completely (including tray) and retry.' }
  if ($Mode -eq 'Install') {
    if (-not $ProfileDirectory) {
      $defaultProfile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
      $answer = Read-Host "DSH profile folder (Enter = $defaultProfile)"
      $ProfileDirectory = if ($answer) { $answer.Trim('"') } else { $defaultProfile }
    }
    & (Join-Path $PSScriptRoot 'install-local.ps1') -DshDirectory $DshDirectory -ProfileDirectory $ProfileDirectory -SourceDirectory (Join-Path (Split-Path -Parent $PSScriptRoot) 'plugin')
    $env:GUARD_PACKAGE = Join-Path $DshDirectory 'plugins\dsh-ustc-api-guard'
    $env:DSH_PROFILE = $ProfileDirectory
    $env:ELECTRON_RUN_AS_NODE = '1'
    & $exe (Join-Path $PSScriptRoot 'check-installation.mjs') | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Post-install verification failed. Keep the displayed backups.' }
  }
  Write-Host 'SUCCESS. You can now start DSH normally.' -ForegroundColor Green
  exit 0
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
