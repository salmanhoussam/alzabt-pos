param(
  [Parameter(Mandatory)][ValidateSet('Initialize', 'Verify')][string] $Mode,
  [string] $ExpectedBaselineSha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Candidate only. This script is never run on the shared host. These environment
# assertions constrain a disposable CI workflow; they are not authentication.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:RUNNER_OS -ne 'Windows' -or $env:GITHUB_EVENT_NAME -ne 'push' -or
    $env:GITHUB_REPOSITORY -ne 'salmanhoussam/alzabt-pos' -or
    $env:GITHUB_REF -ne 'refs/heads/codex/functional-trial-installer-20261124' -or
    $env:GITHUB_SHA -cnotmatch '^[a-f0-9]{40}$' -or -not $env:RUNNER_TEMP) {
  throw 'Disposable hosted trial branch required'
}
if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) { throw '64-bit Windows and PowerShell required' }
$local = [Environment]::GetFolderPath('LocalApplicationData')
$roaming = [Environment]::GetFolderPath('ApplicationData')
foreach ($root in @($local, $roaming, $env:RUNNER_TEMP)) {
  if (-not [IO.Path]::IsPathFullyQualified($root) -or [IO.Path]::GetPathRoot($root) -eq $root) { throw 'Invalid runner shell folder' }
}
$install = Join-Path $local 'Programs\Alzabt POS'
$profile = Join-Path $roaming 'Alzabt POS'
$installSentinel = Join-Path $install 'sentinel.txt'
$profileSentinel = Join-Path $profile 'sentinel.sqlite'
$keys = @(
  'Software\069d885f-7fe3-5e70-89af-9c43433003b5',
  'Software\Microsoft\Windows\CurrentVersion\Uninstall\069d885f-7fe3-5e70-89af-9c43433003b5',
  'Software\Microsoft\Windows\CurrentVersion\Uninstall\Alzabt POS'
)
$baseline = Join-Path $env:RUNNER_TEMP 'alzabt-trial-evidence\runner-sentinels.json'

function Assert-OrdinaryExistingAncestors([string] $path) {
  $current = [IO.Path]::GetFullPath($path)
  for (;;) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Redirected sentinel ancestor refused' }
    }
    $parent = [IO.Directory]::GetParent($current)
    if ($null -eq $parent) { break }
    $current = $parent.FullName
  }
}
function Add-RegistryState([Microsoft.Win32.RegistryKey] $key, [string] $relative, [System.Collections.Generic.List[object]] $entries) {
  $entries.Add([ordered]@{ key = $relative; entry = 'key' })
  foreach ($name in @($key.GetValueNames() | Sort-Object)) {
    $kind = $key.GetValueKind($name).ToString()
    $value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($kind -eq 'Binary' -or $kind -eq 'None') { $value = [Convert]::ToBase64String([byte[]] $value) }
    $entries.Add([ordered]@{ key = $relative; entry = 'value'; name = $name; kind = $kind; value = $value })
  }
  foreach ($name in @($key.GetSubKeyNames() | Sort-Object)) {
    $child = $key.OpenSubKey($name, $false)
    if ($null -eq $child) { throw 'Sentinel subkey disappeared' }
    try { Add-RegistryState $child "$relative\$name" $entries } finally { $child.Dispose() }
  }
}
function Get-RegistryHash([string] $keyPath) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, $false)
  if ($null -eq $key) { throw "Sentinel registry key missing: $keyPath" }
  try {
    $entries = [System.Collections.Generic.List[object]]::new()
    Add-RegistryState $key '' $entries
    $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($entries.ToArray()) -Depth 20 -Compress))
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToHexString($hash.ComputeHash($bytes)).ToLowerInvariant() } finally { $hash.Dispose() }
  } finally { $key.Dispose() }
}
function Get-FileState([string] $file) {
  $item = Get-Item -LiteralPath $file -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid sentinel file' }
  return [ordered]@{ sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant(); created = $item.CreationTimeUtc.Ticks; modified = $item.LastWriteTimeUtc.Ticks }
}
function Get-State {
  Assert-OrdinaryExistingAncestors $install
  Assert-OrdinaryExistingAncestors $profile
  if (@(Get-ChildItem -LiteralPath $install -Force).Count -ne 1 -or @(Get-ChildItem -LiteralPath $profile -Force).Count -ne 1) { throw 'Unexpected entry in runner sentinel directory' }
  $registry = [ordered]@{}
  foreach ($keyPath in $keys) { $registry[$keyPath] = Get-RegistryHash $keyPath }
  return [ordered]@{ install = (Get-FileState $installSentinel); profile = (Get-FileState $profileSentinel); registry = $registry }
}

if ($Mode -eq 'Initialize') {
  # Check every target before any write. Existing profiles/keys are never read.
  if ((Test-Path -LiteralPath $install) -or (Test-Path -LiteralPath $profile) -or (Test-Path -LiteralPath $baseline)) { throw 'Runner sentinel targets are not fresh' }
  foreach ($keyPath in $keys) { if (Test-Path -LiteralPath ('HKCU:\' + $keyPath)) { throw 'Runner sentinel registry key already exists' } }
  Assert-OrdinaryExistingAncestors (Join-Path $local 'Programs')
  Assert-OrdinaryExistingAncestors $roaming
  Assert-OrdinaryExistingAncestors ([IO.Path]::GetDirectoryName($baseline))
  New-Item -ItemType Directory -Path $install, $profile -ErrorAction Stop | Out-Null
  [IO.File]::WriteAllText($installSentinel, 'SYNTHETIC RUNNER PRODUCTION INSTALL SENTINEL')
  [IO.File]::WriteAllText($profileSentinel, 'SYNTHETIC RUNNER PRODUCTION PROFILE SENTINEL')
  foreach ($keyPath in $keys) {
    $providerPath = 'HKCU:\' + $keyPath
    New-Item -Path $providerPath -ErrorAction Stop | Out-Null
    New-ItemProperty -Path $providerPath -Name Sentinel -Value 'synthetic-runner-production-sentinel' -PropertyType String -ErrorAction Stop | Out-Null
  }
  $state = Get-State
  [IO.File]::WriteAllText($baseline, (ConvertTo-Json -InputObject $state -Depth 20 -Compress), [Text.UTF8Encoding]::new($false))
  (Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash.ToLowerInvariant()
} else {
  if ($ExpectedBaselineSha256 -cnotmatch '^[a-f0-9]{64}$' -or
      (Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedBaselineSha256) { throw 'Runner sentinel baseline hash mismatch' }
  $expected = [IO.File]::ReadAllText($baseline)
  $actual = ConvertTo-Json -InputObject (Get-State) -Depth 20 -Compress
  if ($actual -cne $expected) { throw 'Runner production-like sentinel changed' }
  Write-Output 'Runner production-like sentinels unchanged'
}
