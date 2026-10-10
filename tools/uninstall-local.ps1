param(
  [Parameter(Mandatory=$true)][string]$DshDirectory,
  [Parameter(Mandatory=$true)][string]$ApplicationExecutable,
  [Parameter(Mandatory=$true)][string]$ProfileDirectory,
  [Parameter(Mandatory=$true)][string]$PluginDirectory
)
$ErrorActionPreference='Stop'
$taskProfile=[IO.Path]::GetFullPath($ProfileDirectory)
$taskRoot=[IO.Path]::GetFullPath($PluginDirectory)
$taskInstalled=Join-Path $taskRoot 'dsh-ustc-api-guard'
$taskProfileFile=Join-Path $taskProfile 'package.json'
$taskLink=Join-Path $taskProfile 'node_modules\@local\dsh-ustc-api-guard'
$taskName='@local/dsh-ustc-api-guard'
$taskId=(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[Guid]::NewGuid().ToString('N')
$taskBackup=Join-Path $taskProfile ('.plugin-manager\backups\guard-uninstall-'+$taskId)
$taskTemp=Join-Path $taskProfile ('.guard-uninstall-'+$taskId+'.tmp')
$taskLockPath=Join-Path $taskRoot '.ustc-guard-install.lock'
function Assert-UninstallStopped {
  $taskBoundary=[IO.Path]::GetFullPath($DshDirectory).TrimEnd('\')+'\'
  $taskRunning=@(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($ApplicationExecutable)) -ErrorAction SilentlyContinue | Where-Object {-not $_.Path -or $_.Path.StartsWith($taskBoundary,[StringComparison]::OrdinalIgnoreCase)})
  if($taskRunning.Count -or @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($taskBoundary,[StringComparison]::OrdinalIgnoreCase)}).Count){throw 'Save work and fully exit application and updater before uninstalling.'}
}
function Assert-UninstallTree([string]$Path) {
  $taskInfo=Get-Item -LiteralPath $Path -Force
  if($taskInfo.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Uninstall target contains a link; preserved.'}
  if($taskInfo.PSIsContainer){foreach($taskChild in Get-ChildItem -LiteralPath $Path -Force){Assert-UninstallTree $taskChild.FullName}}
}
if(-not $taskRoot.StartsWith($taskProfile.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Uninstall package root must be inside selected profile.'}
Assert-UninstallStopped
$taskOriginal=[IO.File]::ReadAllBytes($taskProfileFile)
$taskData=Get-Content -LiteralPath $taskProfileFile -Raw -Encoding UTF8 | ConvertFrom-Json
if(-not $taskData.dsh.profile){throw 'Invalid profile'}
$taskExisting=Get-Item -LiteralPath $taskLink -Force -ErrorAction SilentlyContinue
if($taskExisting -and $taskExisting.LinkType -ne 'Junction'){throw 'Unmanaged package directory; preserved unchanged.'}
$taskOldTarget=if($taskExisting){[string]$taskExisting.Target}else{$null}
$taskDependency=$taskData.dependencies.$taskName
if($taskOldTarget -and $taskDependency -ne ('link:'+$taskOldTarget.Replace('\','/'))){throw 'Profile dependency and link do not agree; preserved unchanged.'}
if(-not $taskDependency -and -not $taskExisting -and $taskData.dsh.profile.bundles -notcontains $taskName){Write-Output 'Plugin is not enabled in this profile; nothing to uninstall.';return}
$taskOwnRuntime=Test-Path -LiteralPath $taskInstalled -PathType Container
if($taskOwnRuntime){
  Assert-UninstallTree $taskInstalled
  $taskPackage=Get-Content -LiteralPath (Join-Path $taskInstalled 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if($taskPackage.name -ne $taskName){throw 'Uninstall target is not this plugin.'}
}
$taskLock=$null;$taskMoved=$false;$taskLinkRemoved=$false;$taskCommitted=$false
try {
  New-Item -ItemType Directory -Path $taskRoot -Force | Out-Null
  $taskLock=[IO.File]::Open($taskLockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  New-Item -ItemType Directory -Path $taskBackup -Force | Out-Null
  [IO.File]::WriteAllBytes((Join-Path $taskBackup 'package.json'),$taskOriginal)
  if($taskOldTarget){[IO.File]::WriteAllText((Join-Path $taskBackup 'previous-link-target.txt'),$taskOldTarget)}
  if($taskData.dependencies){$taskData.dependencies.PSObject.Properties.Remove($taskName)}
  $taskData.dsh.profile.bundles=@($taskData.dsh.profile.bundles | Where-Object {$_ -ne $taskName})
  [IO.File]::WriteAllText($taskTemp,($taskData | ConvertTo-Json -Depth 60)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
  Assert-UninstallStopped
  if([Convert]::ToBase64String([IO.File]::ReadAllBytes($taskProfileFile)) -ne [Convert]::ToBase64String($taskOriginal)){throw 'Profile changed during preparation; retry.'}
  $taskNow=Get-Item -LiteralPath $taskLink -Force -ErrorAction SilentlyContinue
  if([bool]$taskNow -ne [bool]$taskExisting -or ($taskNow -and ($taskNow.LinkType -ne 'Junction' -or [string]$taskNow.Target -ne $taskOldTarget))){throw 'Package link changed during preparation.'}
  if($taskOwnRuntime){Move-Item -LiteralPath $taskInstalled -Destination (Join-Path $taskBackup 'plugin');$taskMoved=$true}
  if($taskExisting){[IO.Directory]::Delete($taskLink);$taskLinkRemoved=$true}
  [IO.File]::Replace($taskTemp,$taskProfileFile,(Join-Path $taskBackup 'package-before-commit.json'));$taskCommitted=$true
  $taskFinal=Get-Content -LiteralPath $taskProfileFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if($taskFinal.dependencies.$taskName -or $taskFinal.dsh.profile.bundles -contains $taskName -or (Get-Item -LiteralPath $taskLink -Force -ErrorAction SilentlyContinue)){throw 'Final uninstall verification failed.'}
  Write-Output ('UNINSTALLED. Backup: '+$taskBackup)
  Write-Output 'Usage records and other profile settings were retained.'
  if($taskOldTarget -and [IO.Path]::GetFullPath($taskOldTarget) -ne $taskInstalled){Write-Output ('Legacy runtime files retained: '+$taskOldTarget)}
} catch {
  $taskFailure=$_
  try {
    if($taskCommitted){[IO.File]::WriteAllBytes($taskTemp,$taskOriginal);[IO.File]::Replace($taskTemp,$taskProfileFile,(Join-Path $taskBackup 'package-failed-uninstall.json'))}
    if($taskMoved){Move-Item -LiteralPath (Join-Path $taskBackup 'plugin') -Destination $taskInstalled}
    if($taskLinkRemoved){New-Item -ItemType Junction -Path $taskLink -Target $taskOldTarget | Out-Null}
  }catch{Write-Warning ('Rollback requires recovery from '+$taskBackup+': '+$_.Exception.Message)}
  throw $taskFailure
} finally {
  if(Test-Path -LiteralPath $taskTemp){Remove-Item -LiteralPath $taskTemp -Force}
  if($taskLock){$taskLock.Dispose();Remove-Item -LiteralPath $taskLockPath -Force}
}
