# Launched ONLY by scripts/trial-hosted-supervisor.ps1 under the disposable local alzabt-test account.
# Inputs are explicit parameters: a process started with -Credential does not reliably inherit the
# runner's environment, so nothing here depends on GITHUB_* or RUNNER_* variables.
param(
  [Parameter(Mandatory)][string] $ArtifactDir,
  [Parameter(Mandatory)][string] $InstallerSha256,
  [Parameter(Mandatory)][string] $ManifestSha256,
  [Parameter(Mandatory)][string] $NodeExe,
  [Parameter(Mandatory)][string] $WorkRoot
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# The supervisor writes this marker (Administrators/SYSTEM-only writable) after verifying the hosted runner.
$marker = Join-Path $WorkRoot 'supervisor.marker'
if (-not [IO.Path]::IsPathFullyQualified($WorkRoot) -or -not (Test-Path -LiteralPath $marker -PathType Leaf) -or
    -not [IO.Path]::IsPathFullyQualified($NodeExe) -or -not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
  throw 'Disposable hosted runner supervisor required'
}
if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) { throw '64-bit Windows and PowerShell required for the NSIS registry view' }
if ((Select-String -Quiet -Path 'build/trial-installer.nsh' -Pattern '^!error ')) {
  throw 'The installer compilation barrier is still active; stop before building or executing it'
}

# The GitHub-hosted Windows runner itself is an administrator. This script must
# instead be launched by a reviewed supervisor under a fresh disposable local
# alzabt-test account with its profile loaded. Do not infer this from per-user
# NSIS options or environment variables alone.
$whoami = Join-Path $env:SystemRoot 'System32\whoami.exe'
$identity = & $whoami /user /fo csv /nh
if ($LASTEXITCODE -ne 0) { throw 'Cannot query Windows identity' }
$groups = & $whoami /groups /fo csv /nh
if ($LASTEXITCODE -ne 0) { throw 'Cannot query Windows token groups' }
$userRow = @($identity | ConvertFrom-Csv -Header Account,Sid)
if ($userRow.Count -ne 1 -or $userRow[0].Account -ine "$env:COMPUTERNAME\alzabt-test" -or
    $userRow[0].Sid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { throw 'Requires the disposable local alzabt-test account' }
$groupSids = @($groups | ConvertFrom-Csv -Header Name,Type,Sid,Attributes | ForEach-Object { $_.Sid })
foreach ($required in @('S-1-1-0', 'S-1-5-113', 'S-1-5-32-545', 'S-1-16-8192')) {
  if ($required -notin $groupSids) { throw 'Requires a standard-user medium-integrity token' }
}
if ('S-1-5-32-544' -in $groupSids -or @($groupSids | Where-Object { $_ -match '^S-1-16-(\d+)$' -and [int]$Matches[1] -gt 8192 }).Count -gt 0) {
  throw 'Administrator or elevated token refused'
}

$local = [Environment]::GetFolderPath('LocalApplicationData')
$roaming = [Environment]::GetFolderPath('ApplicationData')
$userProfile = [Environment]::GetFolderPath('UserProfile')
if (-not [IO.Path]::IsPathFullyQualified($local) -or -not [IO.Path]::IsPathFullyQualified($roaming) -or
    -not [IO.Path]::IsPathFullyQualified($userProfile)) { throw 'Missing shell folders' }
# A -Credential child can inherit the RUNNER account's environment block. Re-derive every per-user location from
# THIS token's shell folders (long paths, no 8.3 names) so nothing below, nor node/Electron, uses the runner's.
$userTemp = Join-Path $local 'Temp'
New-Item -ItemType Directory -Path $userTemp -Force | Out-Null
$env:USERPROFILE = $userProfile
$env:LOCALAPPDATA = $local
$env:APPDATA = $roaming
$env:TEMP = $userTemp
$env:TMP = $userTemp
$probe = Join-Path $userTemp ('alzabt-trial-write-' + [Guid]::NewGuid().ToString('N'))
[IO.File]::WriteAllText($probe, 'probe'); Remove-Item -LiteralPath $probe
$installDir = Join-Path $local 'Programs\alzabt-pos-trial'
$productionInstall = Join-Path $local 'Programs\Alzabt POS'
$productionProfile = Join-Path $roaming 'Alzabt POS'
$productionKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Alzabt POS'
$productionAppKey = 'HKCU:\Software\069d885f-7fe3-5e70-89af-9c43433003b5'
$productionGuidUninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\069d885f-7fe3-5e70-89af-9c43433003b5'
$trialKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\d12ac5c3-1e6f-4ff5-a3e9-1fa742309a2e'
$trialAppKey = 'HKCU:\Software\d12ac5c3-1e6f-4ff5-a3e9-1fa742309a2e'
foreach ($path in @($installDir, $productionInstall, $productionProfile, $productionKey, $productionAppKey, $productionGuidUninstallKey, $trialKey, $trialAppKey)) {
  if (Test-Path -LiteralPath $path) { throw "Fresh runner required; already exists: $path" }
}

# These are synthetic, newly created sentinels only. Nothing is removed afterward;
# the disposable VM owns cleanup. Hashes are compared after the whole lifecycle.
New-Item -ItemType Directory -Path $productionInstall, $productionProfile | Out-Null
$installSentinel = Join-Path $productionInstall 'sentinel.txt'
$profileSentinel = Join-Path $productionProfile 'sentinel.sqlite'
[IO.File]::WriteAllText($installSentinel, 'SYNTHETIC PRODUCTION INSTALL SENTINEL')
[IO.File]::WriteAllText($profileSentinel, 'SYNTHETIC PRODUCTION PROFILE SENTINEL')
foreach ($keyPath in @($productionKey, $productionAppKey, $productionGuidUninstallKey)) {
  New-Item -Path $keyPath | Out-Null
  New-ItemProperty -Path $keyPath -Name Sentinel -Value 'synthetic-production-registry-sentinel' -PropertyType String | Out-Null
}
$installHash = (Get-FileHash -LiteralPath $installSentinel -Algorithm SHA256).Hash
$profileHash = (Get-FileHash -LiteralPath $profileSentinel -Algorithm SHA256).Hash
$installTimes = (Get-Item -LiteralPath $installSentinel).CreationTimeUtc.Ticks, (Get-Item -LiteralPath $installSentinel).LastWriteTimeUtc.Ticks
$profileTimes = (Get-Item -LiteralPath $profileSentinel).CreationTimeUtc.Ticks, (Get-Item -LiteralPath $profileSentinel).LastWriteTimeUtc.Ticks

# Hash the complete sentinel key, including empty keys, value names, types and
# raw values. Do not expand REG_EXPAND_SZ when reading it.
function Add-RegistrySnapshot([Microsoft.Win32.RegistryKey] $key, [string] $relative, [System.Collections.Generic.List[object]] $entries) {
  $entries.Add([ordered]@{ key = $relative; entry = 'key' })
  foreach ($name in @($key.GetValueNames() | Sort-Object)) {
    $kind = $key.GetValueKind($name).ToString()
    $value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($kind -eq 'Binary' -or $kind -eq 'None') { $value = [Convert]::ToBase64String([byte[]] $value) }
    $entries.Add([ordered]@{ key = $relative; entry = 'value'; name = $name; kind = $kind; value = $value })
  }
  foreach ($name in @($key.GetSubKeyNames() | Sort-Object)) {
    $child = $key.OpenSubKey($name, $false)
    if ($null -eq $child) { throw 'Registry sentinel subkey disappeared' }
    try { Add-RegistrySnapshot $child "$relative\$name" $entries } finally { $child.Dispose() }
  }
}
function Get-RegistryTreeHash([string] $subKeyPath) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subKeyPath, $false)
  if ($null -eq $key) { throw "Required registry key missing: $subKeyPath" }
  try {
    $entries = [System.Collections.Generic.List[object]]::new()
    Add-RegistrySnapshot $key '' $entries
    $serialized = ConvertTo-Json -InputObject @($entries.ToArray()) -Depth 20 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($serialized)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToHexString($hasher.ComputeHash($bytes)) } finally { $hasher.Dispose() }
  } finally { $key.Dispose() }
}
$productionRegistryPaths = @(
  'Software\Microsoft\Windows\CurrentVersion\Uninstall\Alzabt POS',
  'Software\069d885f-7fe3-5e70-89af-9c43433003b5',
  'Software\Microsoft\Windows\CurrentVersion\Uninstall\069d885f-7fe3-5e70-89af-9c43433003b5'
)
$trialRegistryPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\d12ac5c3-1e6f-4ff5-a3e9-1fa742309a2e'
$trialAppRegistryPath = 'Software\d12ac5c3-1e6f-4ff5-a3e9-1fa742309a2e'
$registryHashes = @{}
foreach ($keyPath in $productionRegistryPaths) {
  $registryHashes[$keyPath] = Get-RegistryTreeHash $keyPath
  if (-not $registryHashes[$keyPath]) { throw 'Registry sentinel snapshot missing' }
  Write-Host "Registry sentinel SHA-256: $keyPath $($registryHashes[$keyPath])"
}
Write-Host "Sentinel SHA-256: install=$installHash profile=$profileHash"
Write-Host "Sentinel UTC creation/last-write ticks: install=$($installTimes -join ',') profile=$($profileTimes -join ',')"

function Assert-Sentinels {
  if ((Get-FileHash -LiteralPath $installSentinel -Algorithm SHA256).Hash -ne $installHash -or
      (Get-FileHash -LiteralPath $profileSentinel -Algorithm SHA256).Hash -ne $profileHash) {
    throw 'Protected sentinel changed'
  }
  foreach ($keyPath in $productionRegistryPaths) {
    if ((Get-RegistryTreeHash $keyPath) -ne $registryHashes[$keyPath]) { throw "Protected registry sentinel changed: $keyPath" }
  }
  $currentInstall = Get-Item -LiteralPath $installSentinel
  $currentProfile = Get-Item -LiteralPath $profileSentinel
  if ($currentInstall.CreationTimeUtc.Ticks -ne $installTimes[0] -or $currentInstall.LastWriteTimeUtc.Ticks -ne $installTimes[1] -or
      $currentProfile.CreationTimeUtc.Ticks -ne $profileTimes[0] -or $currentProfile.LastWriteTimeUtc.Ticks -ne $profileTimes[1]) {
    throw 'Protected sentinel file timestamps changed'
  }
  if (@(Get-ChildItem -LiteralPath $productionInstall -Force).Count -ne 1 -or @(Get-ChildItem -LiteralPath $productionProfile -Force).Count -ne 1) {
    throw 'Unexpected change in protected sentinel directory'
  }
}
function Run-ExactProcess([string] $exe, [string[]] $arguments) {
  $p = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru
  try {
    if (-not $p.WaitForExit(120000)) {
      # Use the retained Process instance, not a new process-name or PID lookup.
      try { if (-not $p.HasExited) { $p.Kill() } } catch [System.InvalidOperationException] { }
      throw "Process $($p.Id) timed out"
    }
    return $p.ExitCode
  } finally {
    $p.Dispose()
  }
}

try {
  # A future reviewed supervisor must transfer only these two artifacts into a
  # dedicated ACL-restricted directory accessible to the disposable user, and
  # pass the runner's pre-transfer hashes. Never build in a runner-owned checkout
  # as the standard user or infer isolation from per-user installation alone.
  $artifactRoot = $ArtifactDir
  $expectedInstallerHash = $InstallerSha256
  $expectedManifestHash = $ManifestSha256
  if (-not $artifactRoot -or -not [IO.Path]::IsPathFullyQualified($artifactRoot) -or
      $expectedInstallerHash -cnotmatch '^[a-f0-9]{64}$' -or $expectedManifestHash -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Restricted artifact directory and runner-recorded hashes are required'
  }
  $artifactInfo = Get-Item -LiteralPath $artifactRoot -Force
  if (-not $artifactInfo.PSIsContainer -or ($artifactInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid artifact directory' }
  $installer = Join-Path $artifactRoot 'Alzabt-POS-TRIAL-TEST-ONLY-Setup-0.1.1.exe'
  $manifest = Join-Path $artifactRoot 'trial-payload-manifest.json'
  foreach ($artifact in @($installer, $manifest)) {
    $info = Get-Item -LiteralPath $artifact -Force
    if ($info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid trial artifact' }
  }
  if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedInstallerHash -or
      (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedManifestHash) {
    throw 'Transferred installer or payload manifest hash differs from the runner build'
  }
  Assert-Sentinels
  Write-Host "Installer SHA-256: $expectedInstallerHash; manifest SHA-256: $expectedManifestHash"
  $code = Run-ExactProcess $installer @('/S')
  if ($code -ne 0) { throw "Install failed: $code" }
  $exe = Join-Path $installDir 'Alzabt POS TRIAL TEST ONLY.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or -not (Test-Path -LiteralPath $trialKey) -or -not (Test-Path -LiteralPath $trialAppKey)) { throw 'Trial EXE or trial registry identity missing' }
  $registeredLocation = Get-ItemPropertyValue -LiteralPath $trialAppKey -Name InstallLocation -ErrorAction Stop
  if ([IO.Path]::GetFullPath($registeredLocation).TrimEnd('\') -ine [IO.Path]::GetFullPath($installDir).TrimEnd('\')) { throw 'Trial registry InstallLocation differs from fixed trial directory' }
  # The EXE expectation comes from the prepackaged build manifest, not from the
  # installed file itself. The uninstaller hash was recorded during install;
  # it is an accidental-replacement check, not independent provenance proof.
  $recordedUninstaller = Get-ItemPropertyValue -LiteralPath $trialAppKey -Name TrialUninstallerSHA256 -ErrorAction Stop
  # The installer wrote a 128-hex proof = SHA-256(reg export app key) + SHA-256(reg export uninstall key)
  # (build/trial-installer.nsh, customInstall: FileWrite "$R6$R7"). Recompute it the same way, so the verifier
  # binds the installed proof file to the CURRENT trial registration.
  $regExe = Join-Path $env:SystemRoot 'System32\reg.exe'
  $proofParts = foreach ($key in @('HKCU\Software\d12ac5c3-1e6f-4ff5-a3e9-1fa742309a2e',
      'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\d12ac5c3-1e6f-4ff5-a3e9-1fa742309a2e')) {
    $export = Join-Path $userTemp ('alzabt-trial-reg-' + [Guid]::NewGuid().ToString('N') + '.reg')
    & $regExe export $key $export /y /reg:64 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Cannot export trial registry key: $key" }
    (Get-FileHash -LiteralPath $export -Algorithm SHA256).Hash.ToLowerInvariant()
    Remove-Item -LiteralPath $export
  }
  $registryProof = ($proofParts -join '')
  if ($registryProof -cnotmatch '^[a-f0-9]{128}$') { throw 'Cannot compute the expected registry proof' }
  $verificationJson = & $NodeExe scripts/trial-verify-installed.cjs $installDir $manifest $recordedUninstaller $registryProof
  if ($LASTEXITCODE -ne 0) { throw 'Installed trial differs from its prepackaged payload' }
  $verification = ($verificationJson | Out-String | ConvertFrom-Json)
  if ($verification.executableSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Missing build-bound executable hash' }
  $env:ALZABT_TRIAL_INSTALLED_EXE_SHA256 = $verification.executableSha256
  # Launch the real installed app under this standard account through its LOCAL-account gate: one synthetic
  # financial transaction, close, reopen, totals re-checked (e2e/trial-runtime-smoke.mjs --installed-local).
  # The hosted synthetic-runner path stays covered by tests/main/trialBootstrap.test.ts; it is not launched here.
  $env:APPDATA = $roaming
  # The smoke helper requires the hosted-runner markers even in local mode (e2e/trial-smoke-env.mjs) and then
  # strips them from the APP's environment, so the app is exercised through its local-account gate. They are set
  # explicitly because this -Credential child does not reliably inherit them; the supervisor verified the runner.
  $env:GITHUB_ACTIONS = 'true'
  $env:RUNNER_ENVIRONMENT = 'github-hosted'
  $env:ALZABT_SYNTHETIC_RUNNER_ONLY = '1'
  $env:RUNNER_TEMP = Join-Path $WorkRoot 'evidence'
  & $NodeExe e2e/trial-runtime-smoke.mjs --installed-local
  if ($LASTEXITCODE -ne 0) { throw "Installed local-account app smoke failed: $LASTEXITCODE" }
  $localProfile = Join-Path $roaming 'Alzabt POS TRIAL Test Data'
  $localLedger = Join-Path $localProfile 'alzabt-pos-trial-only-ledger.sqlite'
  if (-not (Test-Path -LiteralPath $localLedger -PathType Leaf)) { throw 'Trial ledger missing after the smoke' }
  $localLedgerHash = (Get-FileHash -LiteralPath $localLedger -Algorithm SHA256).Hash
  $before = Get-ChildItem -LiteralPath $installDir -Recurse -File | Sort-Object FullName | Get-FileHash -Algorithm SHA256 | ConvertTo-Json -Compress
  $trialRegistryBefore = Get-RegistryTreeHash $trialRegistryPath
  $trialAppRegistryBefore = Get-RegistryTreeHash $trialAppRegistryPath
  if (-not $trialRegistryBefore -or -not $trialAppRegistryBefore) { throw 'Trial registry snapshot missing' }
  $second = Run-ExactProcess $installer @('/S')
  if ($second -eq 0) { throw 'Second install did not report refusal' }
  $after = Get-ChildItem -LiteralPath $installDir -Recurse -File | Sort-Object FullName | Get-FileHash -Algorithm SHA256 | ConvertTo-Json -Compress
  if ($before -ne $after -or (Get-RegistryTreeHash $trialRegistryPath) -ne $trialRegistryBefore -or (Get-RegistryTreeHash $trialAppRegistryPath) -ne $trialAppRegistryBefore) { throw 'Second install changed the existing trial' }
  $uninstallers = @(Get-ChildItem -LiteralPath $installDir -File -Filter 'Uninstall*.exe')
  if ($uninstallers.Count -ne 1) { throw 'Expected exactly one trial uninstaller in the fixed trial directory' }
  . ./scripts/trial-temporary-uninstall.ps1
  $uninstallPlan = New-TrialTemporaryUninstallPlan -InstallDirectory $installDir -ExpectedLocalAppData $local `
    -InstalledUninstaller $uninstallers[0].FullName -TempRoot $userTemp `
    -ExpectedUninstallerSha256 $verification.uninstallerSha256
  # Candidate follows NSIS Appendix D by executing a verified temporary copy
  # with _?= as the last unquoted parameter. Keep this stop until the actual
  # generated uninstaller and this completion behavior are reviewed and tested.
  $uninstall = Invoke-TrialTemporaryUninstallPlan $uninstallPlan
  Assert-Sentinels
  if ($uninstall -ne 0) { throw "Uninstall failed: $uninstall" }
  if ((Test-Path -LiteralPath $installDir) -or (Test-Path -LiteralPath $trialKey) -or (Test-Path -LiteralPath $trialAppKey)) { throw 'Trial installation or registry key remains' }
  if (-not (Test-Path -LiteralPath $localLedger) -or (Get-FileHash -LiteralPath $localLedger -Algorithm SHA256).Hash -ne $localLedgerHash) { throw 'Local trial userData was not retained' }
  Write-Host 'Installed trial lifecycle passed. Backup and restore remain blocked by trial policy.'
} finally {
  Assert-Sentinels
  Write-Host 'Protected synthetic sentinels unchanged.'
}
