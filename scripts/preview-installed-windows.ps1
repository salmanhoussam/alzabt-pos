# Launched ONLY by scripts/preview-hosted-supervisor.ps1 under the disposable local alzabt-test account.
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
if ((Select-String -Quiet -Path 'build/preview-installer.nsh' -Pattern '^!error ')) {
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

# A -Credential child inherits the RUNNER account's environment block, and known folders expand with that
# %USERPROFILE% (hosted run 45497204656 got C:\Users\runneradmin\AppData\Local). Resolve the profile from
# the token SID via ProfileList + the loaded hive, set the per-user environment, and only then require every
# known folder to equal the resolved path. Nothing below, nor node/Electron, may use the runner's locations.
. ./scripts/preview-user-profile.ps1
Write-Host "Inherited USERPROFILE before correction: $env:USERPROFILE"
$facts = Get-TrialUserProfileFacts -Sid $userRow[0].Sid
$resolved = Resolve-TrialUserProfile -Sid $userRow[0].Sid -UserName 'alzabt-test' -ProfileImagePath $facts.ProfileImagePath `
  -ProfilesDirectory $facts.ProfilesDirectory -HiveLoaded $facts.HiveLoaded -ProfileExists $facts.ProfileExists
Set-TrialUserEnvironment $resolved
# Query the known folders in a FRESH process that inherits the corrected environment: that is exactly what
# node, Electron and the smoke see, and it avoids any per-process shell-folder cache in this pwsh.
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$folders = @(& $windowsPowerShell -NoProfile -NonInteractive -Command `
  "[Environment]::GetFolderPath('UserProfile'); [Environment]::GetFolderPath('LocalApplicationData'); [Environment]::GetFolderPath('ApplicationData')")
if ($LASTEXITCODE -ne 0 -or $folders.Count -ne 3) { throw 'Cannot query known folders in a fresh process' }
$userProfile, $local, $roaming = $folders
Write-Host "Fresh-process known folders: $($folders -join '; ')"
Assert-TrialKnownFolders -Resolved $resolved -UserProfile $userProfile -Local $local -Roaming $roaming
$local = $resolved.Local
$roaming = $resolved.Roaming
$userTemp = $resolved.Temp
New-Item -ItemType Directory -Path $userTemp -Force | Out-Null
Write-Host "Test-user profile $($resolved.Profile) (SID $($userRow[0].Sid)); LOCALAPPDATA $local; TEMP $userTemp"
$probe = Join-Path $userTemp ('alzabt-trial-write-' + [Guid]::NewGuid().ToString('N'))
[IO.File]::WriteAllText($probe, 'probe'); Remove-Item -LiteralPath $probe
$installDir = Join-Path $local 'Programs\alzabt-pos-r5-preview'
$productionInstall = Join-Path $local 'Programs\Alzabt POS'
$productionProfile = Join-Path $roaming 'Alzabt POS'
$productionKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Alzabt POS'
$productionAppKey = 'HKCU:\Software\069d885f-7fe3-5e70-89af-9c43433003b5'
$productionGuidUninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\069d885f-7fe3-5e70-89af-9c43433003b5'
$trialKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\7b0f3e52-4c8a-4f61-9a3d-5e2b8c71d4a9'
$trialAppKey = 'HKCU:\Software\7b0f3e52-4c8a-4f61-9a3d-5e2b8c71d4a9'
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
  # A brand-new profile may lack the Uninstall parent; each leaf was proven absent above, so -Force only
  # creates missing parents (same defect as the supervisor in run 45491441362).
  New-Item -Path $keyPath -Force | Out-Null
  New-ItemProperty -Path $keyPath -Name Sentinel -Value 'synthetic-production-registry-sentinel' -PropertyType String | Out-Null
}
$installHash = (Get-FileHash -LiteralPath $installSentinel -Algorithm SHA256).Hash
$profileHash = (Get-FileHash -LiteralPath $profileSentinel -Algorithm SHA256).Hash
$installTimes = (Get-Item -LiteralPath $installSentinel).CreationTimeUtc.Ticks, (Get-Item -LiteralPath $installSentinel).LastWriteTimeUtc.Ticks
$profileTimes = (Get-Item -LiteralPath $profileSentinel).CreationTimeUtc.Ticks, (Get-Item -LiteralPath $profileSentinel).LastWriteTimeUtc.Ticks
# OWNER PREVIEW: a synthetic stand-in for the owner's installed R3 TRIAL (its folder, its ledger with the PEPSI sale,
# its two registry keys, GUID d12ac5c3-…). The preview must leave every one of them byte-identical.
$r3Install = Join-Path $local 'Programs\alzabt-pos-trial'
$r3Profile = Join-Path $roaming 'Alzabt POS TRIAL Test Data'
$r3Keys = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\d12ac5c3-1e6f-4ff5-a3e9-1fa742309a2e',
  'HKCU:\Software\d12ac5c3-1e6f-4ff5-a3e9-1fa742309a2e')
foreach ($path in @($r3Install, $r3Profile) + $r3Keys) { if (Test-Path -LiteralPath $path) { throw "Fresh runner required; already exists: $path" } }
New-Item -ItemType Directory -Path $r3Install, $r3Profile | Out-Null
$r3Files = @((Join-Path $r3Install 'Alzabt POS TRIAL TEST ONLY.exe'), (Join-Path $r3Profile 'alzabt-pos-trial-only-ledger.sqlite'))
[IO.File]::WriteAllText($r3Files[0], 'SYNTHETIC R3 TRIAL EXE SENTINEL')
[IO.File]::WriteAllText($r3Files[1], 'SYNTHETIC R3 TRIAL LEDGER SENTINEL - PEPSI 2.00 USD')
foreach ($keyPath in $r3Keys) {
  New-Item -Path $keyPath -Force | Out-Null
  New-ItemProperty -Path $keyPath -Name Sentinel -Value 'synthetic-r3-trial-registry-sentinel' -PropertyType String | Out-Null
}
function Get-R3SentinelState {
  ($r3Files | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }) +
  ($r3Keys | ForEach-Object { (Get-ItemPropertyValue -LiteralPath $_ -Name Sentinel) }) -join '|'
}
$r3Before = Get-R3SentinelState

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
$trialRegistryPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\7b0f3e52-4c8a-4f61-9a3d-5e2b8c71d4a9'
$trialAppRegistryPath = 'Software\7b0f3e52-4c8a-4f61-9a3d-5e2b8c71d4a9'
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
  $installer = Join-Path $artifactRoot 'Alzabt-POS-R5-PREVIEW-OWNER-ONLY-Setup-0.1.1.exe'
  $manifest = Join-Path $artifactRoot 'preview-payload-manifest.json'
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
  $exe = Join-Path $installDir 'Alzabt POS R5 PREVIEW.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or -not (Test-Path -LiteralPath $trialKey) -or -not (Test-Path -LiteralPath $trialAppKey)) { throw 'Trial EXE or trial registry identity missing' }
  $registeredLocation = Get-ItemPropertyValue -LiteralPath $trialAppKey -Name InstallLocation -ErrorAction Stop
  if ([IO.Path]::GetFullPath($registeredLocation).TrimEnd('\') -ine [IO.Path]::GetFullPath($installDir).TrimEnd('\')) { throw 'Trial registry InstallLocation differs from fixed trial directory' }
  # The EXE expectation comes from the prepackaged build manifest, not from the
  # installed file itself. The uninstaller hash was recorded during install;
  # it is an accidental-replacement check, not independent provenance proof.
  $recordedUninstaller = Get-ItemPropertyValue -LiteralPath $trialAppKey -Name TrialUninstallerSHA256 -ErrorAction Stop
  # The installer wrote a 128-hex proof = SHA-256(reg export app key) + SHA-256(reg export uninstall key)
  # (build/preview-installer.nsh, customInstall: FileWrite "$R6$R7"). Recompute it the same way, so the verifier
  # binds the installed proof file to the CURRENT trial registration.
  $regExe = Join-Path $env:SystemRoot 'System32\reg.exe'
  $proofParts = foreach ($key in @('HKCU\Software\7b0f3e52-4c8a-4f61-9a3d-5e2b8c71d4a9',
      'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\7b0f3e52-4c8a-4f61-9a3d-5e2b8c71d4a9')) {
    $export = Join-Path $userTemp ('alzabt-trial-reg-' + [Guid]::NewGuid().ToString('N') + '.reg')
    & $regExe export $key $export /y /reg:64 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Cannot export trial registry key: $key" }
    (Get-FileHash -LiteralPath $export -Algorithm SHA256).Hash.ToLowerInvariant()
    Remove-Item -LiteralPath $export
  }
  $registryProof = ($proofParts -join '')
  if ($registryProof -cnotmatch '^[a-f0-9]{128}$') { throw 'Cannot compute the expected registry proof' }
  $verificationJson = & $NodeExe scripts/preview-verify-installed.cjs $installDir $manifest $recordedUninstaller $registryProof
  if ($LASTEXITCODE -ne 0) { throw 'Installed trial differs from its prepackaged payload' }
  $verification = ($verificationJson | Out-String | ConvertFrom-Json)
  if ($verification.executableSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Missing build-bound executable hash' }
  $env:ALZABT_PREVIEW_INSTALLED_EXE_SHA256 = $verification.executableSha256
  # OWNER PREVIEW: launch the real installed app under this standard account. The smoke covers the launcher
  # (only «جرّب النظام»; business channels refused in main), a fresh in-memory Demo (22 products, 8 categories, a cash
  # sale with exact USD totals, the LBP line with stored USD unchanged), the reset on reopen, and that no Demo ledger
  # or sale id is left on disk (e2e/preview-demo-smoke.mjs).
  $env:APPDATA = $roaming
  # On a smoke failure the screenshot + sanitized visible state go here; the supervisor granted this account Modify on
  # exactly this folder and copies it into the uploaded evidence even when the lifecycle fails.
  $smokeEvidence = Join-Path $WorkRoot 'evidence'
  if (-not (Test-Path -LiteralPath $smokeEvidence -PathType Container)) { throw 'Smoke evidence directory missing' }
  $env:ALZABT_PREVIEW_EVIDENCE_DIR = $smokeEvidence
  & $NodeExe e2e/preview-demo-smoke.mjs
  if ($LASTEXITCODE -ne 0) { throw "Installed preview Demo smoke failed: $LASTEXITCODE" }
  # The preview's data folder (and nothing of the R3 trial or the shop product) is what the app created.
  $previewData = Join-Path $local 'Alzabt-R5-Owner-Preview'
  $previewDataInfo = Get-Item -LiteralPath $previewData -Force -ErrorAction Stop
  if (-not $previewDataInfo.PSIsContainer -or ($previewDataInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Preview data folder missing or redirected' }
  # The production and R3 folders exist here ON PURPOSE (synthetic sentinels created above) and are proven untouched by
  # their hash checks. What must NEVER exist is a real ledger under the preview's own roaming profile: the Demo ledger
  # is :memory: and the launcher's lives in its synthetic folder under LocalAppData.
  $forbiddenLedger = Join-Path $roaming 'Alzabt POS R5 PREVIEW\alzabt-pos-ledger.sqlite'
  if (Test-Path -LiteralPath $forbiddenLedger) { throw "The preview created a ledger outside its own folder: $forbiddenLedger" }
  $previewDataHash = Get-ChildItem -LiteralPath $previewData -Recurse -File | Sort-Object FullName | Get-FileHash -Algorithm SHA256 | ConvertTo-Json -Compress
  $before = Get-ChildItem -LiteralPath $installDir -Recurse -File | Sort-Object FullName | Get-FileHash -Algorithm SHA256 | ConvertTo-Json -Compress
  $trialRegistryBefore = Get-RegistryTreeHash $trialRegistryPath
  $trialAppRegistryBefore = Get-RegistryTreeHash $trialAppRegistryPath
  if (-not $trialRegistryBefore -or -not $trialAppRegistryBefore) { throw 'Preview registry snapshot missing' }
  $second = Run-ExactProcess $installer @('/S')
  if ($second -eq 0) { throw 'Second install did not report refusal' }
  $after = Get-ChildItem -LiteralPath $installDir -Recurse -File | Sort-Object FullName | Get-FileHash -Algorithm SHA256 | ConvertTo-Json -Compress
  if ($before -ne $after -or (Get-RegistryTreeHash $trialRegistryPath) -ne $trialRegistryBefore -or (Get-RegistryTreeHash $trialAppRegistryPath) -ne $trialAppRegistryBefore) { throw 'Second install changed the existing preview' }
  $uninstallers = @(Get-ChildItem -LiteralPath $installDir -File -Filter 'Uninstall*.exe')
  if ($uninstallers.Count -ne 1) { throw 'Expected exactly one preview uninstaller in the fixed preview directory' }
  . ./scripts/preview-temporary-uninstall.ps1
  $uninstallPlan = New-TrialTemporaryUninstallPlan -InstallDirectory $installDir -ExpectedLocalAppData $local `
    -InstalledUninstaller $uninstallers[0].FullName -TempRoot $userTemp `
    -ExpectedUninstallerSha256 $verification.uninstallerSha256
  # Candidate follows NSIS Appendix D by executing a verified temporary copy
  # with _?= as the last unquoted parameter (no NSIS self-copy child), and waits for it.
  $uninstall = Invoke-TrialTemporaryUninstallPlan $uninstallPlan
  Assert-Sentinels
  if ($uninstall -ne 0) { throw "Uninstall failed: $uninstall" }
  if ((Test-Path -LiteralPath $installDir) -or (Test-Path -LiteralPath $trialKey) -or (Test-Path -LiteralPath $trialAppKey)) { throw 'Preview installation or registry key remains' }
  # Uninstall keeps the preview's own data folder exactly as it was (deleteAppDataOnUninstall: false).
  $previewDataAfter = Get-ChildItem -LiteralPath $previewData -Recurse -File | Sort-Object FullName | Get-FileHash -Algorithm SHA256 | ConvertTo-Json -Compress
  if ($previewDataAfter -ne $previewDataHash) { throw 'Uninstall changed the preview data folder' }
  if ((Get-R3SentinelState) -cne $r3Before) { throw 'The preview changed the R3 trial sentinels' }
  Write-Host 'R3 trial sentinels (install, ledger, registry) unchanged.'
  Write-Host 'Installed R5 OWNER PREVIEW lifecycle passed. Restore, import, enrollment, phone and OCR are refused by preview policy.'
} finally {
  Assert-Sentinels
  Write-Host 'Protected synthetic sentinels unchanged.'
}
