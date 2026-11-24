# TEST ONLY — runs as the GitHub-hosted runner's own (administrator) account, on a disposable VM.
# It never installs or launches the trial itself. It:
#   1. refuses anything but a fresh GitHub-hosted Windows runner;
#   2. plants synthetic "production" sentinels in the RUNNER account (a second account on the same VM);
#   3. creates the disposable STANDARD user `alzabt-test` with a random password;
#   4. copies only the built installer and payload manifest into an Administrators-owned directory the
#      trial account can read but not write, and re-verifies their SHA-256;
#   5. runs scripts/trial-installed-windows.ps1 AS alzabt-test (profile loaded, no elevation), waits for it,
#      and propagates its exact exit code;
#   6. re-checks that nothing of the runner account changed and that the trial did not land in it.
# Nothing of a real shop, merchant or the owner's machine is reachable from here.
param(
  [Parameter(Mandatory)][string] $Installer,
  [Parameter(Mandatory)][string] $Manifest,
  [Parameter(Mandatory)][string] $EvidenceDir
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or
    -not $env:GITHUB_WORKSPACE -or -not [Environment]::Is64BitProcess) {
  throw 'Disposable 64-bit GitHub-hosted Windows runner required'
}
$user = 'alzabt-test'
$work = 'C:\alzabt-trial-work'
if (Get-LocalUser -Name $user -ErrorAction SilentlyContinue) { throw "Fresh runner required: local user $user exists" }
if (Test-Path -LiteralPath $work) { throw "Fresh runner required: $work exists" }
New-Item -ItemType Directory -Path $EvidenceDir -Force | Out-Null

# ── 2 · runner-account sentinels (the "other account" on the same machine) ─────────────────────────
$runnerRoaming = [Environment]::GetFolderPath('ApplicationData')
$runnerLocal = [Environment]::GetFolderPath('LocalApplicationData')
$runnerProfile = Join-Path $runnerRoaming 'Alzabt POS'
$runnerInstall = Join-Path $runnerLocal 'Programs\Alzabt POS'
$runnerKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Alzabt POS'
$runnerTrialDir = Join-Path $runnerLocal 'Programs\alzabt-pos-trial'
$runnerTrialKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\d12ac5c3-1e6f-4ff5-a3e9-1fa742309a2e'
foreach ($p in @($runnerProfile, $runnerInstall, $runnerKey, $runnerTrialDir, $runnerTrialKey)) {
  if (Test-Path -LiteralPath $p) { throw "Fresh runner required: $p exists" }
}
New-Item -ItemType Directory -Path $runnerProfile, $runnerInstall | Out-Null
[IO.File]::WriteAllText((Join-Path $runnerProfile 'alzabt-pos-ledger.sqlite'), 'SYNTHETIC RUNNER-ACCOUNT PRODUCTION LEDGER SENTINEL')
[IO.File]::WriteAllText((Join-Path $runnerInstall 'Alzabt POS.exe'), 'SYNTHETIC RUNNER-ACCOUNT PRODUCTION EXE SENTINEL')
New-Item -Path $runnerKey | Out-Null
New-ItemProperty -Path $runnerKey -Name Sentinel -Value 'synthetic-runner-production-key' -PropertyType String | Out-Null
function Get-RunnerSentinelState {
  $files = @(Get-ChildItem -LiteralPath $runnerProfile, $runnerInstall -Recurse -Force | Sort-Object FullName |
    ForEach-Object { if ($_.PSIsContainer) { "D $($_.FullName)" } else { "F $($_.FullName) $((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash) $($_.LastWriteTimeUtc.Ticks)" } })
  $key = Get-Item -LiteralPath $runnerKey
  $values = @($key.GetValueNames() | Sort-Object | ForEach-Object { "V $_ $($key.GetValueKind($_)) $($key.GetValue($_))" })
  return (($files + $values) -join "`n")
}
$runnerBefore = Get-RunnerSentinelState

# ── 4 · artifacts, hashed before and after transfer ────────────────────────────────────────────────
$installerHash = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
$manifestHash = (Get-FileHash -LiteralPath $Manifest -Algorithm SHA256).Hash.ToLowerInvariant()
$artifacts = Join-Path $work 'artifacts'
$childEvidence = Join-Path $work 'evidence'
New-Item -ItemType Directory -Path $work, $artifacts, $childEvidence | Out-Null
# Administrators and SYSTEM own the work root; nothing is inherited from C:\.
& icacls.exe $work /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls work root failed: $LASTEXITCODE" }
Copy-Item -LiteralPath $Installer -Destination (Join-Path $artifacts 'Alzabt-POS-TRIAL-TEST-ONLY-Setup-0.1.1.exe')
Copy-Item -LiteralPath $Manifest -Destination (Join-Path $artifacts 'trial-payload-manifest.json')
if ((Get-FileHash -LiteralPath (Join-Path $artifacts 'Alzabt-POS-TRIAL-TEST-ONLY-Setup-0.1.1.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $installerHash -or
    (Get-FileHash -LiteralPath (Join-Path $artifacts 'trial-payload-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifestHash) {
  throw 'Artifact hash changed during transfer'
}
"run=$env:GITHUB_RUN_ID sha=$env:GITHUB_SHA installer=$installerHash manifest=$manifestHash" |
  Set-Content -LiteralPath (Join-Path $work 'supervisor.marker') -Encoding ascii

# ── 3 · the disposable standard user ───────────────────────────────────────────────────────────────
$bytes = [byte[]]::new(24)
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$password = ConvertTo-SecureString ('Tt9!' + [Convert]::ToBase64String($bytes)) -AsPlainText -Force
$bytes = $null
New-LocalUser -Name $user -Password $password -AccountNeverExpires -PasswordNeverExpires -Description 'Disposable Alzabt POS TEST ONLY account' | Out-Null
try { Add-LocalGroupMember -Group 'Users' -Member $user -ErrorAction Stop } catch { if ($_.Exception.Message -notmatch 'already a member') { throw } }
$admins = @(Get-LocalGroupMember -Group 'Administrators' | ForEach-Object { $_.Name })
if ($admins -match "\\$user$") { throw "$user must not be an administrator" }

# The trial account may READ the artifacts, the checked-out workspace (scripts, node_modules) and Node;
# it may WRITE only its own evidence directory. It cannot write the runner's profile (default ACLs).
foreach ($grant in @(@($artifacts, '(OI)(CI)RX'), @($childEvidence, '(OI)(CI)M'), @($env:GITHUB_WORKSPACE, '(OI)(CI)RX'))) {
  & icacls.exe $grant[0] /grant "${user}:$($grant[1])" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls grant failed for $($grant[0]): $LASTEXITCODE" }
}
& icacls.exe $work /grant "${user}:RX" | Out-Null
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$nodeDir = Split-Path -Parent $node
& icacls.exe $nodeDir /grant "${user}:(OI)(CI)RX" | Out-Null
$pwsh = (Get-Command pwsh -CommandType Application | Select-Object -First 1).Source

# ── 5 · run the lifecycle AS alzabt-test ───────────────────────────────────────────────────────────
$script = Join-Path $env:GITHUB_WORKSPACE 'scripts\trial-installed-windows.ps1'
$argList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$script`"",
  '-ArtifactDir', "`"$artifacts`"", '-InstallerSha256', $installerHash, '-ManifestSha256', $manifestHash,
  '-NodeExe', "`"$node`"", '-WorkRoot', "`"$work`"") -join ' '
$credential = [pscredential]::new("$env:COMPUTERNAME\$user", $password)
$stdout = Join-Path $EvidenceDir 'lifecycle-stdout.txt'
$stderr = Join-Path $EvidenceDir 'lifecycle-stderr.txt'
Write-Host "Running the installed lifecycle as $env:COMPUTERNAME\$user (installer $installerHash)"
$child = Start-Process -FilePath $pwsh -ArgumentList $argList -Credential $credential -LoadUserProfile `
  -WorkingDirectory $env:GITHUB_WORKSPACE -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
if (-not $child.WaitForExit(45 * 60 * 1000)) {
  # Only the retained child instance is ever stopped — never by name.
  try { $child.Kill($true) } catch [InvalidOperationException] { }
  throw 'Installed lifecycle timed out'
}
$lifecycleExit = $child.ExitCode
Get-Content -LiteralPath $stdout, $stderr -ErrorAction SilentlyContinue | Write-Host
Copy-Item -Path (Join-Path $childEvidence '*') -Destination $EvidenceDir -Recurse -ErrorAction SilentlyContinue
Write-Host "Installed lifecycle exit code: $lifecycleExit"

# ── 6 · the other account is untouched, and the trial never landed in it ───────────────────────────
$runnerAfter = Get-RunnerSentinelState
if ($runnerAfter -cne $runnerBefore) { throw 'Runner-account production sentinels changed' }
if ((Test-Path -LiteralPath $runnerTrialDir) -or (Test-Path -LiteralPath $runnerTrialKey)) { throw 'Trial reached the runner account' }
Write-Host 'Runner-account (second account) sentinels unchanged; no trial files or keys in that account.'
"lifecycle_exit=$lifecycleExit installer=$installerHash manifest=$manifestHash" | Set-Content -LiteralPath (Join-Path $EvidenceDir 'result.txt')
if ($lifecycleExit -ne 0) { throw "Installed lifecycle failed with exit code $lifecycleExit" }
