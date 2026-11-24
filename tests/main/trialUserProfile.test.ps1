# Focused checks for scripts/trial-user-profile.ps1 (hosted run 45497204656: the alzabt-test child resolved
# LocalApplicationData to C:\Users\runneradmin\AppData\Local through the inherited USERPROFILE).
# Synthetic inputs, plus one READ-ONLY lookup of the current account's own ProfileList entry. Nothing is written.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. ./scripts/trial-user-profile.ps1

$sid = 'S-1-5-21-1111111111-2222222222-3333333333-1005'
$good = @{ Sid = $sid; UserName = 'alzabt-test'; ProfileImagePath = 'C:\Users\alzabt-test'; ProfilesDirectory = 'C:\Users'
  HiveLoaded = $true; ProfileExists = $true }
$failures = New-Object System.Collections.Generic.List[string]
function Expect-Refused([string] $name, [hashtable] $override) {
  $args2 = $good.Clone(); foreach ($k in $override.Keys) { $args2[$k] = $override[$k] }
  $refused = $false
  try { [void](Resolve-TrialUserProfile @args2) } catch { $refused = $true }
  if (-not $refused) { $failures.Add("accepted: $name") }
}

# Positive: authoritative profile resolves to the test user's own folders.
$r = Resolve-TrialUserProfile @good
if ($r.Profile -cne 'C:\Users\alzabt-test' -or $r.Local -cne 'C:\Users\alzabt-test\AppData\Local' -or
    $r.Roaming -cne 'C:\Users\alzabt-test\AppData\Roaming' -or $r.Temp -cne 'C:\Users\alzabt-test\AppData\Local\Temp') {
  $failures.Add('positive resolution differs')
}
# Positive: Windows' collision suffix for a reused account name.
$suffix = $good.Clone(); $suffix.ProfileImagePath = 'C:\Users\alzabt-test.RUNNERVM'
if ((Resolve-TrialUserProfile @suffix).Local -cne 'C:\Users\alzabt-test.RUNNERVM\AppData\Local') { $failures.Add('suffixed profile not resolved') }

# Negative: the exact R2 failure and its neighbours.
Expect-Refused 'runneradmin profile' @{ ProfileImagePath = 'C:\Users\runneradmin' }
Expect-Refused 'prefix-lookalike user' @{ ProfileImagePath = 'C:\Users\alzabt-tester' }
Expect-Refused 'hive not loaded' @{ HiveLoaded = $false }
Expect-Refused 'profile directory missing' @{ ProfileExists = $false }
Expect-Refused 'outside ProfilesDirectory' @{ ProfileImagePath = 'D:\Other\alzabt-test' }
Expect-Refused 'nested below ProfilesDirectory' @{ ProfileImagePath = 'C:\Users\x\alzabt-test' }
Expect-Refused '8.3 short name' @{ ProfileImagePath = 'C:\Users\ALZABT~1' }
Expect-Refused 'dot-dot traversal' @{ ProfileImagePath = 'C:\Users\alzabt-test\..\runneradmin' }
Expect-Refused 'UNC profile' @{ ProfileImagePath = '\\server\Users\alzabt-test'; ProfilesDirectory = '\\server\Users' }
Expect-Refused 'relative profile' @{ ProfileImagePath = 'Users\alzabt-test' }
Expect-Refused 'well-known SID' @{ Sid = 'S-1-5-18' }

# Known folders must equal the resolved ones exactly (case-insensitive).
$ok = $false
try { Assert-TrialKnownFolders -Resolved $r -UserProfile 'c:\users\ALZABT-TEST' -Local 'C:\Users\alzabt-test\AppData\Local\' -Roaming 'C:\Users\alzabt-test\AppData\Roaming'; $ok = $true } catch { }
if (-not $ok) { $failures.Add('matching known folders refused') }
foreach ($case in @(
    @{ n = 'R2: LocalApplicationData under runneradmin'; u = 'C:\Users\alzabt-test'; l = 'C:\Users\runneradmin\AppData\Local'; a = 'C:\Users\alzabt-test\AppData\Roaming' },
    @{ n = 'UserProfile under runneradmin'; u = 'C:\Users\runneradmin'; l = 'C:\Users\alzabt-test\AppData\Local'; a = 'C:\Users\alzabt-test\AppData\Roaming' },
    @{ n = 'redirected Roaming'; u = 'C:\Users\alzabt-test'; l = 'C:\Users\alzabt-test\AppData\Local'; a = 'D:\Redirected\Roaming' },
    @{ n = 'empty known folder'; u = 'C:\Users\alzabt-test'; l = ''; a = 'C:\Users\alzabt-test\AppData\Roaming' })) {
  $refused = $false
  try { Assert-TrialKnownFolders -Resolved $r -UserProfile $case.u -Local $case.l -Roaming $case.a } catch { $refused = $true }
  if (-not $refused) { $failures.Add("accepted known folder: $($case.n)") }
}

# Real Windows, read-only: this account's own ProfileList entry resolves, its hive is loaded, and its known folders
# (in a process whose environment is its own) agree with the authoritative resolution.
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$facts = Get-TrialUserProfileFacts -Sid $me.User.Value
$myName = $me.Name.Split('\')[-1]
$mine = Resolve-TrialUserProfile -Sid $me.User.Value -UserName $myName -ProfileImagePath $facts.ProfileImagePath `
  -ProfilesDirectory $facts.ProfilesDirectory -HiveLoaded $facts.HiveLoaded -ProfileExists $facts.ProfileExists
Assert-TrialKnownFolders -Resolved $mine -UserProfile ([Environment]::GetFolderPath('UserProfile')) `
  -Local ([Environment]::GetFolderPath('LocalApplicationData')) -Roaming ([Environment]::GetFolderPath('ApplicationData'))

if ($failures.Count) { $failures | ForEach-Object { Write-Host "FAIL $_" }; exit 1 }
Write-Host 'PASS trial user profile: 2 positive, 11 refused profiles, 4 refused known folders, real ProfileList read-only'
