<#
Synthetic Windows lock check for alzabt-test. This file does NOT start WPR or
prove absence of filesystem reads. Never run it under the owner's account.
It creates only a fresh test-account directory and does not delete it.
#>
[CmdletBinding()]
param([switch]$Run)
$ErrorActionPreference = "Stop"

if (-not $Run) { throw "Preparation only. Run with -Run from an alzabt-test PowerShell." }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$testUser = Get-LocalUser -Name "alzabt-test" -ErrorAction Stop
if ($identity.User.Value -ne $testUser.SID.Value) {
  throw "STOP: this PowerShell is not running as alzabt-test."
}
$profileKey = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + $identity.User.Value
$registered = [Environment]::ExpandEnvironmentVariables(
  (Get-ItemPropertyValue -LiteralPath $profileKey -Name ProfileImagePath -ErrorAction Stop))
$profile = [Environment]::GetFolderPath("UserProfile")
$local = [Environment]::GetFolderPath("LocalApplicationData")
$roaming = [Environment]::GetFolderPath("ApplicationData")
$registered = [IO.Path]::GetFullPath($registered).TrimEnd('\')
$profile = [IO.Path]::GetFullPath($profile).TrimEnd('\')
$local = [IO.Path]::GetFullPath($local).TrimEnd('\')
$roaming = [IO.Path]::GetFullPath($roaming).TrimEnd('\')
if (-not $registered.Equals($profile,[StringComparison]::OrdinalIgnoreCase)) {
  throw "STOP: registered profile and current test profile do not match."
}
foreach ($pair in @(@($env:LOCALAPPDATA,$local),@($env:APPDATA,$roaming))) {
  if ([string]::IsNullOrWhiteSpace($pair[0]) -or
      -not [IO.Path]::GetFullPath($pair[0]).TrimEnd([char]92).Equals($pair[1],[StringComparison]::OrdinalIgnoreCase)) {
    throw "STOP: process application-data environment differs from this test user's known folders."
  }
}
foreach ($folder in @($local,$roaming)) {
  if (-not $folder.StartsWith($profile + '\',[StringComparison]::OrdinalIgnoreCase)) {
    throw "STOP: an application-data folder is outside the test profile."
  }
}
foreach ($folder in @($profile,$local,$roaming)) {
  $part = Get-Item -LiteralPath $folder -Force
  while ($null -ne $part) {
    if (($part.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "STOP: a test-profile path component is a reparse point."
    }
    $part = $part.Parent
  }
}

$repo = "C:\dev\alzabt-pos-joint-codex"
$exe = Join-Path $repo "node_modules\electron\dist\electron.exe"
$main = Join-Path $repo "dist\main\main\main.js"
$renderer = Join-Path $repo "dist\renderer\index.html"
$buildInfo = Join-Path $repo "dist\build-info.json"
foreach ($file in @($exe,$main,$renderer,$buildInfo)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    throw "STOP: test build/dependencies are not readable; do not change ACLs automatically."
  }
}
$build = Get-Content -LiteralPath $buildInfo -Raw | ConvertFrom-Json
if ($build.build -ne "5d7a165-dirty") { throw "STOP: unexpected build identity." }
if ((Get-FileHash -LiteralPath $main -Algorithm SHA256).Hash -ne "E47A365932F29B069EC8D44AD8A662DE3538A85780AFF86BFD6CE487F54A2D5") {
  throw "STOP: main runtime differs from the reviewed test build."
}
if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne "4D313D128CB9D2412DC17A7BEEFB1D79269825E3A3FFA0AF611C203C836A1AB6") {
  throw "STOP: Electron executable differs from the reviewed test build."
}

$root = Join-Path $local ("Alzabt-Synthetic-Lock-" + [guid]::NewGuid().ToString("N"))
if (Test-Path -LiteralPath $root) { throw "STOP: generated synthetic test directory already exists." }
New-Item -ItemType Directory -Path $root | Out-Null
Write-Output ("Synthetic test root: " + $root)
Write-Output "No WPR trace is started; file-read absence cannot be inferred from this check."
$env:ALZABT_POS_DISABLE_AUTOSTART = "1"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
Remove-Item Env:ALZABT_POS_DEMO_CATALOG -ErrorAction SilentlyContinue

function Start-SyntheticPos([string]$profileDir) {
  $env:ALZABT_POS_USER_DATA = $profileDir
  $env:ALZABT_POS_DIAG_LOG = Join-Path $profileDir "synthetic-diag.jsonl"
  $proc = Start-Process -FilePath $exe -ArgumentList @("--disable-background-networking",$repo) -WorkingDirectory $repo -WindowStyle Hidden -PassThru
  # Pin a handle to the process object we just created; never look up or kill by name.
  $pinned = $proc.Handle
  $start = $proc.StartTime.ToUniversalTime()
  if (-not [IO.Path]::GetFullPath($proc.Path).Equals([IO.Path]::GetFullPath($exe),[StringComparison]::OrdinalIgnoreCase)) {
    throw "STOP: started process executable is not the reviewed Electron binary."
  }
  return @{ Process=$proc; PinnedHandle=$pinned; StartUtc=$start; Profile=$profileDir }
}
function Wait-SyntheticLedger($owned) {
  $diag = Join-Path $owned.Profile "synthetic-diag.jsonl"
  for ($i=0; $i -lt 300; $i++) {
    $owned.Process.Refresh()
    if ($owned.Process.HasExited) { throw "STOP: owned test POS exited before ledger opened." }
    if ((Test-Path -LiteralPath $diag) -and (Select-String -LiteralPath $diag -SimpleMatch '"event":"ledger-open"' -Quiet)) {
      return
    }
    Start-Sleep -Milliseconds 100
  }
  throw "STOP: timed out waiting for synthetic ledger; leave the test process for owner inspection."
}
function Stop-OwnedTestProcess($owned,[bool]$tryGraceful) {
  $proc=$owned.Process
  $proc.Refresh()
  if ($proc.HasExited) { return "already-exited" }
  if ($proc.StartTime.ToUniversalTime() -ne $owned.StartUtc -or
      -not [IO.Path]::GetFullPath($proc.Path).Equals([IO.Path]::GetFullPath($exe),[StringComparison]::OrdinalIgnoreCase)) {
    throw "STOP: owned test process identity cannot be verified."
  }
  if ($tryGraceful -and $proc.CloseMainWindow() -and $proc.WaitForExit(15000)) {
    return "graceful"
  }
  # Owner authorized force-kill/crash testing of newly created synthetic test processes only.
  $proc.Refresh()
  if (-not $proc.HasExited) { $proc.Kill(); if (-not $proc.WaitForExit(15000)) { throw "STOP: owned test process did not exit." } }
  if ($tryGraceful) { return "graceful-blocked-then-owned-kill" }
  return "owned-kill"
}
function Invoke-LockCase([string]$label,[bool]$tryGraceful,[bool]$reverse) {
  $caseRoot=Join-Path $root $label
  $a=Join-Path $caseRoot "profile-a"
  $b=Join-Path $caseRoot "profile-b"
  New-Item -ItemType Directory -Path $caseRoot | Out-Null
  New-Item -ItemType Directory -Path $a,$b | Out-Null
  if ($reverse) { $swap=$a; $a=$b; $b=$swap }
  $first=Start-SyntheticPos $a
  Wait-SyntheticLedger $first
  $second=Start-SyntheticPos $b
  if (-not $second.Process.WaitForExit(30000)) {
    throw "STOP: second owned process did not exit. No process was terminated automatically."
  }
  $first.Process.Refresh()
  if ($first.Process.HasExited) { throw "STOP: first test process exited unexpectedly." }
  $secondaryEmpty=@(Get-ChildItem -LiteralPath $b -Force).Count -eq 0
  if ($second.Process.ExitCode -ne 0 -or -not $secondaryEmpty) {
    throw "STOP: second process did not exit cleanly or wrote to synthetic profile B."
  }
  $stopKind=Stop-OwnedTestProcess $first $tryGraceful
  $restart=Start-SyntheticPos $b
  Wait-SyntheticLedger $restart
  $restartStop=Stop-OwnedTestProcess $restart $false
  return @{ case=$label; secondExit=0; secondProfileEmpty=$true; firstStop=$stopKind;
    restartedWithSyntheticLedger=$true; restartStop=$restartStop }
}

$results=@()
$results += Invoke-LockCase "profile-a-first" $true $false
$results += Invoke-LockCase "profile-b-first" $false $true
$report=@{ testAccount="alzabt-test"; build=$build.build; cases=$results;
  fileAccessTrace="NOT RUN"; noReadClaim=$false; actualDemoMode="NOT RUN";
  oldNewCompatibility="NOT RUN"; crossUserExclusion="NOT TESTED";
  osIsolation="NOT PROVEN"; userProfileIsSynthetic=$true }
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root "results.json") -Encoding UTF8
$report | ConvertTo-Json -Depth 5
