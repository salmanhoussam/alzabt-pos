# Review candidate only. Dot-sourcing defines functions and performs no action.
# NSIS Appendix D documents that a temporary copy with a final, unquoted _?=
# argument does not make the additional self-copy. Runtime behavior and the
# effective uninstaller must be independently reviewed on the disposable runner.
function Assert-TrialOrdinaryAncestors([string] $Path) {
  $current = [IO.Path]::GetFullPath($Path)
  for (;;) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'PREVIEW refuses a redirected or non-directory ancestor'
    }
    $parent = [IO.Directory]::GetParent($current)
    if ($null -eq $parent) { break }
    $current = $parent.FullName
  }
}

function New-TrialTemporaryUninstallPlan {
  param(
    [Parameter(Mandatory)][string] $InstallDirectory,
    [Parameter(Mandatory)][string] $ExpectedLocalAppData,
    [Parameter(Mandatory)][string] $InstalledUninstaller,
    [Parameter(Mandatory)][string] $TempRoot,
    [Parameter(Mandatory)][string] $ExpectedUninstallerSha256
  )
  $install = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
  $local = [IO.Path]::GetFullPath($ExpectedLocalAppData).TrimEnd('\')
  $source = [IO.Path]::GetFullPath($InstalledUninstaller)
  $temp = [IO.Path]::GetFullPath($TempRoot).TrimEnd('\')
  if ($install -notmatch '^[A-Za-z]:\\[A-Za-z0-9 _\.\\-]+\\Programs\\alzabt-pos-r5-preview$' -or
      $install -ine (Join-Path $local 'Programs\alzabt-pos-r5-preview') -or
      $temp -notmatch '^[A-Za-z]:\\[A-Za-z0-9 _\.\\-]+$' -or
      $source -ine (Join-Path $install 'Uninstall Alzabt POS R5 PREVIEW.exe') -or
      $ExpectedUninstallerSha256 -cnotmatch '^[a-f0-9]{64}$') {
    throw 'PREVIEW refuses an unexpected uninstaller path or hash'
  }
  if ($temp.StartsWith($install + '\', [StringComparison]::OrdinalIgnoreCase) -or
      $temp.Equals($install, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'PREVIEW uninstaller copy must be outside the install directory'
  }
  Assert-TrialOrdinaryAncestors $install
  Assert-TrialOrdinaryAncestors $temp
  $sourceInfo = Get-Item -LiteralPath $source -Force -ErrorAction Stop
  if ($sourceInfo.PSIsContainer -or ($sourceInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedUninstallerSha256) {
    throw 'PREVIEW refuses an unexpected installed uninstaller'
  }
  $copyDir = Join-Path $temp ('alzabt-trial-uninstall-' + [Guid]::NewGuid().ToString('N'))
  if (Test-Path -LiteralPath $copyDir) { throw 'PREVIEW refuses an existing uninstaller-copy directory' }
  return [pscustomobject]@{
    InstallDirectory = $install
    ExpectedLocalAppData = $local
    InstalledUninstaller = $source
    TempRoot = $temp
    CopyDirectory = $copyDir
    CopyPath = (Join-Path $copyDir 'Uninstall Alzabt POS R5 PREVIEW.exe')
    ExpectedSha256 = $ExpectedUninstallerSha256
    Arguments = '/S _?=' + $install
  }
}

function Invoke-TrialTemporaryUninstallPlan {
  param([Parameter(Mandatory)] $Plan)
  # Reject a stale or accidentally modified plan before creating the copy.
  $checked = New-TrialTemporaryUninstallPlan -InstallDirectory $Plan.InstallDirectory `
    -ExpectedLocalAppData $Plan.ExpectedLocalAppData -InstalledUninstaller $Plan.InstalledUninstaller `
    -TempRoot $Plan.TempRoot -ExpectedUninstallerSha256 $Plan.ExpectedSha256
  $copyParent = [IO.Directory]::GetParent([IO.Path]::GetFullPath($Plan.CopyDirectory))
  if ($null -eq $copyParent -or $copyParent.FullName -ine $checked.TempRoot -or
      [IO.Path]::GetFileName($Plan.CopyDirectory) -cnotmatch '^alzabt-trial-uninstall-[0-9a-f]{32}$' -or
      $Plan.CopyPath -ine (Join-Path $Plan.CopyDirectory 'Uninstall Alzabt POS R5 PREVIEW.exe') -or
      $Plan.Arguments -cne $checked.Arguments -or (Test-Path -LiteralPath $Plan.CopyDirectory)) {
    throw 'PREVIEW refuses a modified or stale uninstaller-copy plan'
  }
  # Recheck immediately before copy; checks do not claim atomicity against a
  # malicious same-user process, which is outside the selected threat model.
  Assert-TrialOrdinaryAncestors $Plan.InstallDirectory
  Assert-TrialOrdinaryAncestors ([IO.Directory]::GetParent($Plan.CopyDirectory).FullName)
  if ((Get-FileHash -LiteralPath $Plan.InstalledUninstaller -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Plan.ExpectedSha256) {
    throw 'PREVIEW installed uninstaller changed before copy'
  }
  New-Item -ItemType Directory -Path $Plan.CopyDirectory -ErrorAction Stop | Out-Null
  Copy-Item -LiteralPath $Plan.InstalledUninstaller -Destination $Plan.CopyPath -ErrorAction Stop
  $copyInfo = Get-Item -LiteralPath $Plan.CopyPath -Force -ErrorAction Stop
  if ($copyInfo.PSIsContainer -or ($copyInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      (Get-FileHash -LiteralPath $Plan.CopyPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Plan.ExpectedSha256) {
    throw 'PREVIEW copied uninstaller hash differs'
  }
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Plan.CopyPath
  # NSIS requires _?= to be the final, unquoted parameter. UseShellExecute=false
  # passes this exact argument string without a command shell.
  $start.Arguments = $Plan.Arguments
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $process = [Diagnostics.Process]::Start($start)
  if ($null -eq $process) { throw 'PREVIEW could not launch the temporary uninstaller' }
  try {
    if (-not $process.WaitForExit(120000)) {
      try { if (-not $process.HasExited) { $process.Kill() } } catch [InvalidOperationException] { }
      throw 'PREVIEW temporary uninstaller did not finish'
    }
    return $process.ExitCode
  } finally { $process.Dispose() }
}
