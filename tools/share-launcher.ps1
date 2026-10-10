param([ValidateSet('Install','Uninstall')][string]$Mode='Install')
$ErrorActionPreference='Stop'
if([Console]::IsInputRedirected){[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)}
try {
  Write-Host 'USTC API Guard 1.0.0' -ForegroundColor Cyan
  Write-Host 'Save work and completely exit the application, including tray/updater.'
  $taskProduct=Read-Host 'Application: 1 = DSH, 2 = TokenWorks (Enter = 1)'
  $taskProduct=if($taskProduct -eq '2'){'TokenWorks'}elseif(-not $taskProduct -or $taskProduct -eq '1'){'DSH'}else{throw 'Choose 1 or 2.'}
  $taskName=if($taskProduct -eq 'DSH'){'DeepSeek Harness.exe'}else{'EduWork-Electron.exe'}
  $taskApplication=(Read-Host ('Full path to '+$taskName+' (quotes allowed)')).Trim('"')
  $taskProfiles=if($taskProduct -eq 'DSH'){Join-Path $env:USERPROFILE '.dsh\profiles'}else{Join-Path $env:LOCALAPPDATA 'tokenworks-electron\dsh\profiles'}
  $taskCandidates=@(Get-ChildItem -LiteralPath $taskProfiles -Directory -ErrorAction SilentlyContinue | Where-Object {Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') -PathType Leaf} | Sort-Object Name)
  for($taskIndex=0;$taskIndex -lt $taskCandidates.Count;$taskIndex++){Write-Host (('{0}: {1}' -f ($taskIndex+1),$taskCandidates[$taskIndex].FullName))}
  $taskAnswer=Read-Host 'Profile: choose a listed number or enter full folder path containing package.json'
  $taskIndex=0
  if([int]::TryParse($taskAnswer,[ref]$taskIndex) -and $taskIndex -gt 0 -and $taskIndex -le $taskCandidates.Count){$taskProfile=$taskCandidates[$taskIndex-1].FullName}else{$taskProfile=$taskAnswer.Trim('"')}
  if(-not $taskProfile){throw 'Select the actual profile. Start the application once first if no profile exists.'}
  & (Join-Path $PSScriptRoot 'manage-release.ps1') -Mode $Mode -Product $taskProduct -ApplicationPath $taskApplication -ProfileDirectory $taskProfile
  exit $LASTEXITCODE
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
