param(
  [Parameter(Mandatory=$true)][string]$DshDirectory,
  [Parameter(Mandatory=$true)][string]$ProfileDirectory,
  [string]$ApplicationExecutable = 'DeepSeek Harness.exe',
  [string]$PluginDirectory = '',
  [string]$SourceDirectory = ''
)
$ErrorActionPreference = 'Stop'
if (-not $SourceDirectory) { $SourceDirectory = if ((Split-Path -Leaf $PSScriptRoot) -eq '_installer') { Split-Path -Parent $PSScriptRoot } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'plugin' } }
$taskSource = [IO.Path]::GetFullPath($SourceDirectory)
$taskDsh = [IO.Path]::GetFullPath($DshDirectory)
$taskInstallRoot = if ($PluginDirectory) { [IO.Path]::GetFullPath($PluginDirectory) } else { Join-Path $taskDsh 'plugins' }
$taskInstalled = Join-Path $taskInstallRoot 'dsh-ustc-api-guard'
$taskProfile = [IO.Path]::GetFullPath($ProfileDirectory)
$taskProfileFile = Join-Path $taskProfile 'package.json'
$taskLink = Join-Path $taskProfile 'node_modules\@local\dsh-ustc-api-guard'
$taskTransaction = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N')
$taskStage = Join-Path $taskInstallRoot ('.guard-stage-' + $taskTransaction)
$taskArchive = Join-Path $taskInstallRoot ('dsh-ustc-api-guard-backup-' + $taskTransaction)
$taskFailed = Join-Path $taskInstallRoot ('.guard-failed-' + $taskTransaction)
$taskProfileTemp = Join-Path $taskProfile ('.guard-profile-' + $taskTransaction + '.tmp')
$taskBackup = Join-Path $taskProfile ('.plugin-manager\backups\guard-install-' + $taskTransaction)
$taskLockPath = Join-Path $taskInstallRoot '.ustc-guard-install.lock'

function Assert-TaskPath([string]$Path, [string]$Root) {
  $taskAbsolute = [IO.Path]::GetFullPath($Path)
  $taskBoundary = [IO.Path]::GetFullPath($Root).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
  if (-not $taskAbsolute.StartsWith($taskBoundary, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path outside intended directory' }
}
function Assert-TaskTree([string]$Path) {
  $taskItem = Get-Item -LiteralPath $Path -Force
  if ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Package or parent directory contains a link' }
  if ($taskItem.PSIsContainer) {
    foreach ($taskChild in Get-ChildItem -LiteralPath $Path -Force) { Assert-TaskTree $taskChild.FullName }
  }
}
function Remove-TaskTemporaryTree([string]$Path) {
  Assert-TaskPath $Path $taskInstallRoot
  if ($Path -notin @($taskStage, $taskFailed)) { throw 'Refuse deleting non-temporary install directory' }
  if (Test-Path -LiteralPath $Path) {
    Assert-TaskTree $Path
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}
function Get-TaskDigest([string]$Path) {
  $taskHasher = [Security.Cryptography.SHA256]::Create()
  $taskStream = [IO.File]::OpenRead($Path)
  try { return [Convert]::ToBase64String($taskHasher.ComputeHash($taskStream)) }
  finally { $taskStream.Dispose(); $taskHasher.Dispose() }
}

function Assert-TaskApplicationStopped {
  $taskRunning = @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($ApplicationExecutable)) -ErrorAction SilentlyContinue | Where-Object { -not $_.Path -or $_.Path.StartsWith($taskDsh.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) })
  if ($taskRunning.Count) { throw 'Save work and fully exit the application (including tray) before installing.' }
  $taskProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($taskDsh.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) })
  if ($taskProcesses.Count) { throw 'Exit application and updater processes before installing.' }
}

# All validation precedes changing a healthy runtime or profile.
if ([IO.Path]::GetFileName($ApplicationExecutable) -ne $ApplicationExecutable -or $ApplicationExecutable -notlike '*.exe') { throw 'Invalid application executable name' }
if (-not (Test-Path -LiteralPath (Join-Path $taskDsh $ApplicationExecutable) -PathType Leaf)) { throw 'DSH installation not found' }
if (-not (Test-Path -LiteralPath $taskProfileFile -PathType Leaf)) { throw 'DSH profile not found' }
Assert-TaskApplicationStopped
$taskManifest = Get-Content -LiteralPath (Join-Path $taskSource 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$taskProfileBytes = [IO.File]::ReadAllBytes($taskProfileFile)
$taskProfileData = Get-Content -LiteralPath $taskProfileFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($taskManifest.name -ne '@local/dsh-ustc-api-guard' -or -not $taskManifest.version -or -not $taskManifest.files) { throw 'Unexpected or incomplete package' }
if (-not $taskProfileData.dsh.profile) { throw 'Incomplete DSH profile' }
if ((Get-Item -LiteralPath $taskSource -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source package root must be a real directory' }
$taskFiles = @('package.json') + @($taskManifest.files)
foreach ($taskFilename in $taskFiles) {
  if ($taskFilename -isnot [string] -or -not $taskFilename -or $taskFilename -match '(^|[\\/])\.\.([\\/]|$)' -or [IO.Path]::IsPathRooted($taskFilename)) { throw 'Unsafe package file path' }
  $taskFilePath = Join-Path $taskSource $taskFilename
  Assert-TaskPath $taskFilePath $taskSource
  Assert-TaskTree $taskFilePath
}
foreach ($taskRuntimeEntry in @('index.js', 'client.js', 'cordis.patch.yml')) {
  if (-not (Test-Path -LiteralPath (Join-Path $taskSource $taskRuntimeEntry) -PathType Leaf)) { throw 'Missing runtime entry point' }
}
Assert-TaskPath $taskLink $taskProfile
foreach ($taskParent in @($taskProfile, (Join-Path $taskProfile 'node_modules'), (Join-Path $taskProfile 'node_modules\@local'))) {
  $taskParentItem = Get-Item -LiteralPath $taskParent -Force -ErrorAction SilentlyContinue
  if ($taskParentItem -and ($taskParentItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Profile or package parent must not be a link' }
}
$taskOriginalLink = Get-Item -LiteralPath $taskLink -Force -ErrorAction SilentlyContinue
if ($taskOriginalLink -and $taskOriginalLink.LinkType -ne 'Junction') { throw 'Existing package link is not a junction; preserved unchanged' }
$taskOldTarget = if ($taskOriginalLink) { [string]$taskOriginalLink.Target } else { $null }
$taskInstalledInfo = Get-Item -LiteralPath $taskInstalled -Force -ErrorAction SilentlyContinue
if ($taskInstalledInfo -and (-not $taskInstalledInfo.PSIsContainer -or ($taskInstalledInfo.Attributes -band [IO.FileAttributes]::ReparsePoint))) { throw 'Install target must be a real directory' }
if (Test-Path -LiteralPath $taskInstallRoot) {
  if ((Get-Item -LiteralPath $taskInstallRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Plugins directory must not be a link' }
}
foreach ($taskMoveTarget in @($taskInstalled, $taskStage, $taskArchive, $taskFailed)) { Assert-TaskPath $taskMoveTarget $taskInstallRoot }
Assert-TaskPath $taskProfileTemp $taskProfile
Assert-TaskPath $taskBackup $taskProfile

$taskLock = $null
$taskArchived = $false
$taskPromoted = $false
$taskLinkChanged = $false
$taskProfileCommitted = $false
try {
  New-Item -ItemType Directory -Path $taskInstallRoot -Force | Out-Null
  $taskLock = [IO.File]::Open($taskLockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  New-Item -ItemType Directory -Path $taskStage | Out-Null
  foreach ($taskFilename in $taskFiles) {
    Copy-Item -LiteralPath (Join-Path $taskSource $taskFilename) -Destination (Join-Path $taskStage $taskFilename) -Recurse
  }
  Assert-TaskTree $taskStage
  foreach ($taskCopied in Get-ChildItem -LiteralPath $taskStage -Recurse -File -Force) {
    $taskRelative = $taskCopied.FullName.Substring($taskStage.TrimEnd('\','/').Length + 1)
    $taskOriginal = Join-Path $taskSource $taskRelative
    if ((Get-TaskDigest $taskOriginal) -ne (Get-TaskDigest $taskCopied.FullName)) { throw 'Staged file checksum mismatch' }
  }
  if (-not $taskProfileData.dependencies) { $taskProfileData | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
  $taskProfileData.dependencies | Add-Member -NotePropertyName '@local/dsh-ustc-api-guard' -NotePropertyValue ('link:' + $taskInstalled.Replace('\','/')) -Force
  $taskBundles = @($taskProfileData.dsh.profile.bundles)
  if ($taskBundles -notcontains '@local/dsh-ustc-api-guard') { $taskProfileData.dsh.profile.bundles = @($taskBundles + '@local/dsh-ustc-api-guard') }
  [IO.File]::WriteAllText($taskProfileTemp, ($taskProfileData | ConvertTo-Json -Depth 60) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  New-Item -ItemType Directory -Path $taskBackup -Force | Out-Null
  [IO.File]::WriteAllBytes((Join-Path $taskBackup 'package.json'), $taskProfileBytes)
  foreach ($taskFilename in @('pnpm-lock.yaml','cordis.patch.yml')) {
    $taskExisting = Join-Path $taskProfile $taskFilename
    if (Test-Path -LiteralPath $taskExisting) { Copy-Item -LiteralPath $taskExisting -Destination $taskBackup }
  }
  if ($taskOldTarget) { [IO.File]::WriteAllText((Join-Path $taskBackup 'previous-link-target.txt'), $taskOldTarget) }
  # Do not overwrite configuration changed by DSH while the package was staged.
  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($taskProfileFile)) -ne [Convert]::ToBase64String($taskProfileBytes)) { throw 'Profile changed during preparation; retry without overwriting it' }
  $taskCheckedLink = Get-Item -LiteralPath $taskLink -Force -ErrorAction SilentlyContinue
  if ([bool]$taskCheckedLink -ne [bool]$taskOriginalLink -or ($taskCheckedLink -and ($taskCheckedLink.LinkType -ne 'Junction' -or [string]$taskCheckedLink.Target -ne $taskOldTarget))) { throw 'Package link changed during preparation; retry' }
  Assert-TaskApplicationStopped
  if ($taskInstalledInfo) {
    Move-Item -LiteralPath $taskInstalled -Destination $taskArchive
    $taskArchived = $true
  }
  Move-Item -LiteralPath $taskStage -Destination $taskInstalled
  $taskPromoted = $true
  if (-not $taskOldTarget -or [IO.Path]::GetFullPath($taskOldTarget) -ne $taskInstalled) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $taskLink) -Force | Out-Null
    $taskLinkChanged = $true
    if ($taskOriginalLink) { [IO.Directory]::Delete($taskLink) }
    New-Item -ItemType Junction -Path $taskLink -Target $taskInstalled | Out-Null
  }
  [IO.File]::Replace($taskProfileTemp, $taskProfileFile, (Join-Path $taskBackup 'package-before-commit.json'))
  $taskProfileCommitted = $true
  if ([IO.Path]::GetFullPath([string](Get-Item -LiteralPath $taskLink -Force).Target) -ne $taskInstalled) { throw 'Installed link verification failed' }
  # Final verification remains inside the transaction so failure rolls back.
  $taskFinalProfile = Get-Content -LiteralPath $taskProfileFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($taskFinalProfile.dependencies.'@local/dsh-ustc-api-guard' -ne ('link:'+$taskInstalled.Replace('\','/')) -or $taskFinalProfile.dsh.profile.bundles -notcontains '@local/dsh-ustc-api-guard') { throw 'Final profile verification failed' }
  foreach ($taskCopied in Get-ChildItem -LiteralPath $taskInstalled -Recurse -File -Force) {
    $taskRelative = $taskCopied.FullName.Substring($taskInstalled.TrimEnd('\','/').Length + 1)
    if ((Get-TaskDigest (Join-Path $taskSource $taskRelative)) -ne (Get-TaskDigest $taskCopied.FullName)) { throw 'Final installed file checksum mismatch' }
  }
  Write-Output ('INSTALLED ' + $taskManifest.version + ': ' + $taskInstalled)
  Write-Output ('PROFILE BACKUP: ' + $taskBackup)
  Write-Output 'Runtime and profile committed; restart DSH normally to load changed code.'
} catch {
  $taskInstallFailure = $_
  try {
    if ($taskProfileCommitted) {
      [IO.File]::WriteAllBytes($taskProfileTemp, $taskProfileBytes)
      [IO.File]::Replace($taskProfileTemp, $taskProfileFile, (Join-Path $taskBackup 'package-failed-commit.json'))
    }
    if ($taskLinkChanged) {
      $taskCurrentLink = Get-Item -LiteralPath $taskLink -Force -ErrorAction SilentlyContinue
      if ($taskCurrentLink) {
        if ($taskCurrentLink.LinkType -ne 'Junction') { throw 'Rollback refuses replacing unmanaged package directory' }
        [IO.Directory]::Delete($taskLink)
      }
      if ($taskOldTarget) { New-Item -ItemType Junction -Path $taskLink -Target $taskOldTarget | Out-Null }
    }
    if ($taskPromoted) { Move-Item -LiteralPath $taskInstalled -Destination $taskFailed }
    if ($taskArchived) { Move-Item -LiteralPath $taskArchive -Destination $taskInstalled }
    Remove-TaskTemporaryTree $taskStage
    Remove-TaskTemporaryTree $taskFailed
  } catch { Write-Warning ('Rollback needs manual recovery; backups retained at ' + $taskBackup + ': ' + $_.Exception.Message) }
  throw $taskInstallFailure
} finally {
  if (Test-Path -LiteralPath $taskProfileTemp) { Remove-Item -LiteralPath $taskProfileTemp -Force }
  if ($taskLock) {
    $taskLock.Dispose()
    Remove-Item -LiteralPath $taskLockPath -Force
  }
}
