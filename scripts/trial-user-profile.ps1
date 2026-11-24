# Resolves the disposable test user's Windows profile from AUTHORITATIVE sources, never from environment variables.
#
# Why (hosted run 45497204656): a child started with Start-Process -Credential -LoadUserProfile inherits the
# RUNNER's environment block. Known folders are stored as REG_EXPAND_SZ (%USERPROFILE%\AppData\Local), so
# [Environment]::GetFolderPath expanded them with runneradmin's USERPROFILE and returned
# C:\Users\runneradmin\AppData\Local. Order here: token SID -> ProfileList\<SID>\ProfileImagePath (+ the
# profile hive loaded under HKEY_USERS\<SID>) -> set the per-user environment -> only THEN query known folders
# and require them to equal the resolved paths exactly.

function Get-TrialUserProfileFacts {
  param([Parameter(Mandatory)][string] $Sid)
  $listRoot = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
  $entry = Join-Path $listRoot $Sid
  if (-not (Test-Path -LiteralPath $entry)) { throw "No Windows profile is registered for $Sid" }
  # Get-ItemProperty expands REG_EXPAND_SZ with this process's environment; these values use only %SystemDrive%,
  # which is machine-wide, and the result is then validated below (directly under ProfilesDirectory, own leaf).
  $imagePath = (Get-ItemProperty -LiteralPath $entry -Name ProfileImagePath).ProfileImagePath
  $profilesDirectory = (Get-ItemProperty -LiteralPath $listRoot -Name ProfilesDirectory).ProfilesDirectory
  [pscustomobject]@{
    ProfileImagePath  = [string]$imagePath
    ProfilesDirectory = [string]$profilesDirectory
    HiveLoaded        = [bool](Test-Path -LiteralPath ("Registry::HKEY_USERS\$Sid"))
    ProfileExists     = [bool](Test-Path -LiteralPath $imagePath -PathType Container)
  }
}

function Resolve-TrialUserProfile {
  param(
    [Parameter(Mandatory)][string] $Sid,
    [Parameter(Mandatory)][string] $UserName,
    [Parameter(Mandatory)][string] $ProfileImagePath,
    [Parameter(Mandatory)][string] $ProfilesDirectory,
    [Parameter(Mandatory)][bool] $HiveLoaded,
    [Parameter(Mandatory)][bool] $ProfileExists
  )
  if ($Sid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { throw "Not a local account SID: $Sid" }
  if (-not $HiveLoaded) { throw "Profile hive for $Sid is not loaded (supervisor must use -LoadUserProfile)" }
  if (-not $ProfileExists) { throw "Profile directory for $Sid does not exist" }
  foreach ($p in @($ProfileImagePath, $ProfilesDirectory)) {
    # Local drive only (no UNC, no relative), no 8.3 short names, no . or .. segments. PowerShell 5.1 and 7.
    if ($p -notmatch '^[A-Za-z]:\\' -or $p.Contains('~') -or $p -match '(^|\\)\.\.?(\\|$)') {
      throw "Refusing a non-canonical profile path: $p"
    }
  }
  $profileDir = [IO.Path]::GetFullPath($ProfileImagePath).TrimEnd('\')
  $root = [IO.Path]::GetFullPath($ProfilesDirectory).TrimEnd('\')
  if ([IO.Path]::GetDirectoryName($profileDir) -ine $root) { throw "Profile $profileDir is not directly under $root" }
  $leaf = [IO.Path]::GetFileName($profileDir)
  # Windows may suffix a reused name (alzabt-test.COMPUTER); any other leaf (e.g. runneradmin) is refused.
  if ($leaf -ine $UserName -and -not $leaf.StartsWith("$UserName.", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Profile $profileDir does not belong to $UserName"
  }
  $local = Join-Path $profileDir 'AppData\Local'
  [pscustomobject]@{
    Profile = $profileDir
    Local   = $local
    Roaming = Join-Path $profileDir 'AppData\Roaming'
    Temp    = Join-Path $local 'Temp'
  }
}

function Set-TrialUserEnvironment {
  param([Parameter(Mandatory)] $Resolved)
  $env:USERPROFILE = $Resolved.Profile
  $env:HOMEDRIVE = [IO.Path]::GetPathRoot($Resolved.Profile).TrimEnd('\')
  $env:HOMEPATH = $Resolved.Profile.Substring($env:HOMEDRIVE.Length)
  $env:LOCALAPPDATA = $Resolved.Local
  $env:APPDATA = $Resolved.Roaming
  $env:TEMP = $Resolved.Temp
  $env:TMP = $Resolved.Temp
}

function Assert-TrialKnownFolders {
  param(
    [Parameter(Mandatory)] $Resolved,
    [Parameter(Mandatory)][AllowEmptyString()][string] $UserProfile,
    [Parameter(Mandatory)][AllowEmptyString()][string] $Local,
    [Parameter(Mandatory)][AllowEmptyString()][string] $Roaming
  )
  foreach ($pair in @(@($UserProfile, $Resolved.Profile, 'UserProfile'), @($Local, $Resolved.Local, 'LocalApplicationData'),
      @($Roaming, $Resolved.Roaming, 'ApplicationData'))) {
    if (-not $pair[0] -or $pair[0] -notmatch '^[A-Za-z]:\\' -or
        [IO.Path]::GetFullPath($pair[0]).TrimEnd('\') -ine $pair[1].TrimEnd('\')) {
      throw "Known folder $($pair[2]) resolves to '$($pair[0])', not the test user's '$($pair[1])'"
    }
  }
}
