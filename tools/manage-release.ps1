param(
  [ValidateSet('Install','Uninstall')][string]$Mode='Install',
  [Parameter(Mandatory=$true)][ValidateSet('DSH','TokenWorks')][string]$Product,
  [Parameter(Mandatory=$true)][string]$ApplicationPath,
  [Parameter(Mandatory=$true)][string]$ProfileDirectory
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
  if($PSVersionTable.PSVersion -lt [Version]'5.1') { throw '需要 Windows PowerShell 5.1。' }
  $taskPayload=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
  $taskApp=[IO.Path]::GetFullPath($ApplicationPath)
  $taskProfile=[IO.Path]::GetFullPath($ProfileDirectory)
  $taskName=if($Product -eq 'DSH'){'DeepSeek Harness.exe'}else{'EduWork-Electron.exe'}
  if([IO.Path]::GetFileName($taskApp) -ne $taskName -or -not (Test-Path -LiteralPath $taskApp -PathType Leaf)) { throw '程序文件与所选应用不匹配。' }
  $taskAppRoot=Split-Path -Parent $taskApp
  if($Product -eq 'DSH') {
    if(-not (Test-Path -LiteralPath (Join-Path $taskAppRoot 'resources\app.asar') -PathType Leaf)) { throw '所选DSH缺少运行文件。' }
  } else {
    $taskDistribution=Get-Content -LiteralPath (Join-Path $taskAppRoot 'release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if($taskDistribution.distribution -ne 'tokenworks' -or -not (Test-Path -LiteralPath (Join-Path $taskAppRoot 'resources\product\d\package.json') -PathType Leaf)) { throw '所选TokenWorks缺少运行文件或发行标识。' }
  }
  function Assert-ReleaseAncestors([string]$Path) {
    $taskCurrent=[IO.Path]::GetFullPath($Path)
    if($taskCurrent.StartsWith('\\')) { throw '当前安装器仅支持本地NTFS目录。' }
    while($taskCurrent) {
      $taskInfo=Get-Item -LiteralPath $taskCurrent -Force -ErrorAction SilentlyContinue
      if($taskInfo -and ($taskInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '安装路径不能经过目录链接。' }
      $taskCurrent=Split-Path -Parent $taskCurrent
    }
  }
  Assert-ReleaseAncestors $taskProfile
  Assert-ReleaseAncestors $taskPayload
  $taskDrive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($taskProfile))
  if($taskDrive.DriveType -notin @([IO.DriveType]::Fixed,[IO.DriveType]::Removable) -or $taskDrive.DriveFormat -ne 'NTFS') { throw '配置目录需要位于本地NTFS磁盘。' }
  if(-not (Test-Path -LiteralPath (Join-Path $taskProfile 'package.json') -PathType Leaf)) { throw '配置不存在。请先运行应用一次，再选择实际配置。' }
  $taskInstallRoot=Join-Path $taskProfile '.plugin-manager\plugins'
  Assert-ReleaseAncestors $taskInstallRoot
  # Verify every payload byte before loading the transaction installer.
  $taskExpected=@{}
  foreach($taskLine in Get-Content -LiteralPath (Join-Path $PSScriptRoot 'SHA256SUMS.txt') -Encoding UTF8) {
    if($taskLine -notmatch '^([a-f0-9]{64})  (.+)$') { throw '安装清单格式无效。' }
    $taskHash=$Matches[1]; $taskRelative=$Matches[2]
    $taskFile=[IO.Path]::GetFullPath((Join-Path $taskPayload $taskRelative))
    if(-not $taskFile.StartsWith($taskPayload.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or $taskExpected.ContainsKey($taskRelative)) { throw '安装清单路径无效。' }
    Assert-ReleaseAncestors $taskFile
    $taskHasher=[Security.Cryptography.SHA256]::Create(); $taskStream=[IO.File]::OpenRead($taskFile)
    try { $taskDigest=[BitConverter]::ToString($taskHasher.ComputeHash($taskStream)).Replace('-','').ToLowerInvariant() } finally { $taskStream.Dispose(); $taskHasher.Dispose() }
    if($taskDigest -ne $taskHash) { throw ('安装文件损坏：'+$taskRelative) }
    $taskExpected[$taskRelative]=$true
  }
  $taskActual=@(Get-ChildItem -LiteralPath $taskPayload -Recurse -File -Force | Where-Object {$_.FullName -ne (Join-Path $PSScriptRoot 'SHA256SUMS.txt')})
  if($taskExpected.Count -ne $taskActual.Count) { throw '安装包包含清单外文件。' }
  foreach($taskParent in @((Join-Path $taskProfile 'node_modules\@local'),(Join-Path $taskProfile '.plugin-manager\backups'))){Assert-ReleaseAncestors $taskParent}
  if($Mode -eq 'Install') {
    Write-Output ('正在为 '+$Product+' 安装 USTC API Guard 1.0.0…')
    & (Join-Path $PSScriptRoot 'install-local.ps1') -DshDirectory $taskAppRoot -ApplicationExecutable $taskName -PluginDirectory $taskInstallRoot -ProfileDirectory $taskProfile -SourceDirectory (Join-Path $taskPayload 'plugin')
    Write-Output '安装和校验完成。请正常重新启动应用。'
  } else {
    & (Join-Path $PSScriptRoot 'uninstall-local.ps1') -DshDirectory $taskAppRoot -ApplicationExecutable $taskName -PluginDirectory $taskInstallRoot -ProfileDirectory $taskProfile
    Write-Output '卸载完成，已保留用量记录。'
  }
  exit 0
} catch { Write-Output ('安装未完成：'+$_.Exception.Message); exit 1 }
