# Plan-only synthetic checks. No executable or installer is launched.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. ./scripts/trial-temporary-uninstall.ps1
$root = Join-Path ([IO.Path]::GetTempPath()) ('alzabt-uninstall-plan-' + [Guid]::NewGuid().ToString('N'))
$profile = Join-Path $root 'profile'
$programs = Join-Path $profile 'Programs'
$install = Join-Path $programs 'alzabt-pos-trial'
$temp = Join-Path $root 'temp'
$uninstaller = Join-Path $install 'Uninstall Alzabt POS TRIAL TEST ONLY.exe'
try {
  [void][IO.Directory]::CreateDirectory($install)
  [void][IO.Directory]::CreateDirectory($temp)
  [IO.File]::WriteAllText($uninstaller, 'synthetic bytes; not an executable')
  $hash = (Get-FileHash -LiteralPath $uninstaller -Algorithm SHA256).Hash.ToLowerInvariant()
  $plan = New-TrialTemporaryUninstallPlan -InstallDirectory $install -ExpectedLocalAppData $profile -InstalledUninstaller $uninstaller -TempRoot $temp -ExpectedUninstallerSha256 $hash
  if ($plan.Arguments -cne ('/S _?=' + $install) -or $plan.Arguments.Contains('"')) { throw 'Unexpected NSIS argument ordering or quoting' }
  if ((Test-Path -LiteralPath $plan.CopyDirectory) -or $plan.CopyDirectory -notlike (Join-Path $temp 'alzabt-trial-uninstall-*')) { throw 'Unexpected copy location' }
  $badHashRejected = $false
  try { [void](New-TrialTemporaryUninstallPlan -InstallDirectory $install -ExpectedLocalAppData $profile -InstalledUninstaller $uninstaller -TempRoot $temp -ExpectedUninstallerSha256 ('0' * 64)) } catch { $badHashRejected = $true }
  if (-not $badHashRejected) { throw 'Changed uninstaller hash was accepted' }
  $insideRejected = $false
  try { [void](New-TrialTemporaryUninstallPlan -InstallDirectory $install -ExpectedLocalAppData $profile -InstalledUninstaller $uninstaller -TempRoot $install -ExpectedUninstallerSha256 $hash) } catch { $insideRejected = $true }
  if (-not $insideRejected) { throw 'Copy inside the installation was accepted' }
  $wrongLocalRejected = $false
  try { [void](New-TrialTemporaryUninstallPlan -InstallDirectory $install -ExpectedLocalAppData $root -InstalledUninstaller $uninstaller -TempRoot $temp -ExpectedUninstallerSha256 $hash) } catch { $wrongLocalRejected = $true }
  if (-not $wrongLocalRejected) { throw 'An install directory outside the expected local app-data root was accepted' }
  $plan.Arguments = '/S _?=C:\other'
  $modifiedPlanRejected = $false
  try { [void](Invoke-TrialTemporaryUninstallPlan $plan) } catch { $modifiedPlanRejected = $true }
  if (-not $modifiedPlanRejected -or (Test-Path -LiteralPath $plan.CopyDirectory)) { throw 'A modified plan was not rejected before copying' }
  Write-Output 'PASS temporary uninstaller plan: final unquoted _?=, separate temporary path, and mismatch refusals'
} finally {
  if (Test-Path -LiteralPath $uninstaller) { Remove-Item -LiteralPath $uninstaller -Force }
  foreach ($directory in @($install, $programs, $profile, $temp, $root)) {
    if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Force }
  }
}
