; OWNER-ONLY R5 PREVIEW installer (owner decision 2026-11-25), adapted VERBATIM from the reviewed R3 trial installer
; (build/trial-installer.nsh): only the install folder (alzabt-pos-r5-preview) and the message prefix (PREVIEW) differ.
; Identity comes from build/preview.electron-builder.cjs. Not a release; never a merchant machine.

; electron-builder's optional LogSet macro changes $INSTDIR before the trial
; guards. Refuse that builder mode even after the ordinary barrier is reviewed.
!ifdef ENABLE_LOGGING_ELECTRON_BUILDER
  !error "PREVIEW refuses electron-builder pre-guard installer logging"
!endif

; These checks are defense in depth, not a complete lifecycle boundary. In particular,
; electron-builder executes generated operations before and after these hooks.
; Refuse instead of invoking electron-builder's process termination logic. This is
; intentionally not a working installer/uninstaller: the surrounding pre-hook
; SetOutPath and registry-driven upgrade operations still require replacement.
; Candidate non-terminating process check. 603 means no executable by that
; name was found; any match or plugin failure is refused. A same-named unrelated
; executable may cause a safe false refusal. Verify the Unicode plugin on the
; disposable Windows runner before relying on its result.
!macro trialRefuseRunning
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${nsProcess::Unload}
  ${if} $R0 != 603
    Abort "PREVIEW application may be running or cannot be inspected."
  ${endif}
!macroend
!macro customCheckAppRunning
  ; Non-terminating: refuse while a trial process exists; never kill anything.
  !insertmacro trialRefuseRunning
!macroend

; Check each existing component before using the destination. A fixed string
; alone is insufficient: a pre-existing parent junction can redirect it. This
; does not bind the check against a malicious concurrent same-user replacement.
!macro trialCheckDirectoryAncestors START
  StrCpy $R8 "${START}"
  StrCpy $R9 $R8 3
  StrCpy $R7 $R9 2 1
  ${if} $R7 != ":\"
    Abort "PREVIEW requires an absolute local drive path."
  ${endif}
  System::Call 'kernel32::GetDriveTypeW(w "$R9") i.r0'
  ${if} $0 != 3
    Abort "PREVIEW requires a fixed local drive."
  ${endif}
  ; DRIVE_FIXED includes SUBST drives. Permit only a direct Windows hard-disk
  ; volume mapping so a substituted drive cannot hide redirected ancestors.
  StrCpy $R5 $R9 2
  System::Call 'kernel32::QueryDosDeviceW(w "$R5", w .r0, i ${NSIS_MAX_STRLEN}) i.r1'
  ${if} $1 == 0
    Abort "PREVIEW cannot inspect the local drive mapping."
  ${endif}
  StrCpy $R5 $0 22
  ${if} $R5 != "\Device\HarddiskVolume"
    Abort "PREVIEW refuses a substituted or unsupported local drive."
  ${endif}
  StrCpy $R5 $0 "" 22
  ${if} $R5 == ""
    Abort "PREVIEW cannot identify the local drive volume."
  ${endif}
  ${DoWhile} $R5 != ""
    StrCpy $R4 $R5 1
    ${if} $R4 != "0"
    ${andIf} $R4 != "1"
    ${andIf} $R4 != "2"
    ${andIf} $R4 != "3"
    ${andIf} $R4 != "4"
    ${andIf} $R4 != "5"
    ${andIf} $R4 != "6"
    ${andIf} $R4 != "7"
    ${andIf} $R4 != "8"
    ${andIf} $R4 != "9"
      Abort "PREVIEW refuses an unsupported local drive mapping."
    ${endif}
    StrCpy $R5 $R5 "" 1
  ${Loop}
  ${Do}
    System::Call 'kernel32::GetFileAttributesW(w "$R8") i.r0 ?e'
    Pop $1
    ${if} $0 == -1
      ${if} $1 != 2
      ${andIf} $1 != 3
        Abort "PREVIEW cannot inspect a path ancestor."
      ${endif}
    ${else}
      IntOp $R6 $0 & 0x400
      ${if} $R6 != 0
        Abort "PREVIEW refuses a redirected path ancestor."
      ${endif}
      IntOp $R6 $0 & 0x10
      ${if} $R6 == 0
        Abort "PREVIEW requires directory ancestors."
      ${endif}
    ${endif}
    ${if} $R8 == $R9
      ${ExitDo}
    ${endif}
    GetFullPathName $R7 "$R8\.."
    ${if} $R7 == $R8
    ${orIf} $R7 == ""
      Abort "PREVIEW cannot traverse a path ancestor."
    ${endif}
    StrCpy $R8 $R7
  ${Loop}
!macroend

; This hook requires the separately reviewed template candidate. The default
; electron-builder template calls SetOutPath before any supported uninstall hook.
!macro customTrialUnInitBeforePath
  ${if} $INSTDIR != "$LOCALAPPDATA\Programs\alzabt-pos-r5-preview"
    Abort "PREVIEW original uninstallation path refused."
  ${endif}
  !insertmacro trialCheckDirectoryAncestors "$INSTDIR"
!macroend

; Refuse even an empty existing registry key. ERROR_FILE_NOT_FOUND means absent;
; any other error (including access denied) fails closed. This candidate targets
; the x64 build and the builder's 64-bit registry view. Preserve the parent abort.
!macro trialRequireAbsentKey KEY
  System::Call 'advapi32::RegOpenKeyExW(p -2147483647, w "${KEY}", i 0, i 0x101, *p .r0) i.r1'
  ${if} $1 == 0
    System::Call 'advapi32::RegCloseKey(p r0)'
    Abort "PREVIEW refuses an existing registry key."
  ${elseIf} $1 != 2
    Abort "PREVIEW cannot establish registry freshness."
  ${endif}
!macroend

!macro customInit
  ; The standard one-click template can otherwise launch the executable for
  ; --force-run even when runAfterFinish is disabled. Use the builder's own
  ; flag parser so the refusal matches the later launch decision.
  ${if} ${isForceRun}
    Abort "PREVIEW refuses automatic launch."
  ${endif}
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/allusers" $R1
  ${ifNot} ${Errors}
    Abort "PREVIEW refuses machine-wide installation."
  ${endif}
  ${if} $installMode != "CurrentUser"
    Abort "PREVIEW requires per-user installation."
  ${endif}
  ${if} $INSTDIR != "$LOCALAPPDATA\Programs\alzabt-pos-r5-preview"
    Abort "PREVIEW installation path refused."
  ${endif}
  !insertmacro trialCheckDirectoryAncestors "$LOCALAPPDATA\Programs"
  ; Check key existence, not merely a value: generated upgrade logic can execute
  ; an old uninstaller. This remains subject to non-adversarial race assumptions.
  !insertmacro trialRequireAbsentKey "${INSTALL_REGISTRY_KEY}"
  !insertmacro trialRequireAbsentKey "${UNINSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    !insertmacro trialRequireAbsentKey "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  ; GetFileAttributes sees empty directories as well as files. Only explicit
  ; not-found errors permit continuation; this is not an atomic reservation.
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0 ?e'
  Pop $1
  ${if} $0 != -1
    Abort "PREVIEW refuses an existing installation directory."
  ${elseIf} $1 != 2
  ${andIf} $1 != 3
    Abort "PREVIEW cannot establish installation-directory freshness."
  ${endif}
!macroend

; Snapshot only this trial's HKCU trees into the NSIS plugin directory. The
; exported text includes every value and subkey; hashes detect an accidental
; registry change before standard NSIS deletes its own installation keys.
; This is not authentication against deliberate same-user replacement.
!macro trialRegistryHashes APPHASH UNINSTALLHASH
  InitPluginsDir
  nsExec::Exec '"$SYSDIR\reg.exe" export "HKCU\${INSTALL_REGISTRY_KEY}" "$PLUGINSDIR\trial-app.reg" /y /reg:64'
  Pop $0
  ${if} $0 != 0
    Abort "PREVIEW cannot snapshot its installation registry key."
  ${endif}
  nsExec::Exec '"$SYSDIR\reg.exe" export "HKCU\${UNINSTALL_REGISTRY_KEY}" "$PLUGINSDIR\trial-uninstall.reg" /y /reg:64'
  Pop $0
  ${if} $0 != 0
    Abort "PREVIEW cannot snapshot its uninstall registry key."
  ${endif}
  ${StdUtils.HashFile} ${APPHASH} "SHA2-256" "$PLUGINSDIR\trial-app.reg"
  ${StdUtils.HashFile} ${UNINSTALLHASH} "SHA2-256" "$PLUGINSDIR\trial-uninstall.reg"
  StrLen $0 ${APPHASH}
  StrLen $1 ${UNINSTALLHASH}
  ${if} $0 != 64
  ${orIf} $1 != 64
    Abort "PREVIEW cannot hash its registry snapshots."
  ${endif}
!macroend

; Preserve a hash of the actual builder-generated uninstaller after extraction.
; This detects accidental replacement, not malicious same-user registry edits.
!macro customInstall
  ${StdUtils.HashFile} $R0 "SHA2-256" "$INSTDIR\${UNINSTALL_FILENAME}"
  StrLen $R1 $R0
  ${if} $R1 != 64
    Abort "PREVIEW cannot hash its generated uninstaller."
  ${endif}
  ClearErrors
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" TrialUninstallerSHA256 "$R0"
  ${if} ${Errors}
    Abort "PREVIEW cannot record its generated uninstaller."
  ${endif}
  !insertmacro trialRegistryHashes $R6 $R7
  ; The proof name is reserved from the unpacked payload. Never overwrite an
  ; unexpected file if extraction or another program supplied that name.
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\.alzabt-trial-registry-proof") i.r0 ?e'
  Pop $1
  ${if} $0 != -1
    Abort "PREVIEW registry proof location already exists."
  ${elseIf} $1 != 2
  ${andIf} $1 != 3
    Abort "PREVIEW cannot inspect its registry proof location."
  ${endif}
  ClearErrors
  FileOpen $R5 "$INSTDIR\.alzabt-trial-registry-proof" w
  ${if} ${Errors}
    Abort "PREVIEW cannot create its registry proof."
  ${endif}
  FileWrite $R5 "$R6$R7"
  ${if} ${Errors}
    FileClose $R5
    Abort "PREVIEW cannot write its registry proof."
  ${endif}
  FileClose $R5
  ${if} ${Errors}
    Abort "PREVIEW cannot close its registry proof."
  ${endif}
!macroend

!macro customUnInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/allusers" $R1
  ${ifNot} ${Errors}
    Abort "PREVIEW refuses machine-wide uninstallation."
  ${endif}
  ClearErrors
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${ifNot} ${Errors}
    Abort "PREVIEW app-data deletion is disabled."
  ${endif}
  ${if} $installMode != "CurrentUser"
    Abort "PREVIEW requires per-user uninstallation."
  ${endif}
  ${if} $INSTDIR != "$LOCALAPPDATA\Programs\alzabt-pos-r5-preview"
    Abort "PREVIEW uninstallation path refused."
  ${endif}
  !insertmacro trialCheckDirectoryAncestors "$INSTDIR"
  ; Refuse stale or unrelated registration before the generated removal code.
  ClearErrors
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} ${Errors}
  ${orIf} $R0 != "$INSTDIR"
    Abort "PREVIEW installation registration refused."
  ${endif}
  ClearErrors
  ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${if} ${Errors}
  ${orIf} $R0 != '$\"$INSTDIR\${UNINSTALL_FILENAME}$\" /currentuser'
    Abort "PREVIEW uninstall registration refused."
  ${endif}
  ClearErrors
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" TrialUninstallerSHA256
  StrLen $R1 $R0
  ${if} ${Errors}
  ${orIf} $R1 != 64
    Abort "PREVIEW uninstaller identity record refused."
  ${endif}
  ${StdUtils.HashFile} $R1 "SHA2-256" "$INSTDIR\${UNINSTALL_FILENAME}"
  ${if} $R0 != $R1
    Abort "PREVIEW uninstaller identity mismatch."
  ${endif}
  ; Reject a missing, redirected or altered proof before any application-file
  ; removal. The proof contains exactly the two registry-export SHA-256s.
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\.alzabt-trial-registry-proof") i.r0 ?e'
  Pop $1
  ${if} $0 == -1
    Abort "PREVIEW registry proof is missing."
  ${endif}
  IntOp $1 $0 & 0x410
  ${if} $1 != 0
    Abort "PREVIEW registry proof is not an ordinary file."
  ${endif}
  ClearErrors
  FileOpen $R5 "$INSTDIR\.alzabt-trial-registry-proof" r
  ${if} ${Errors}
    Abort "PREVIEW cannot open its registry proof."
  ${endif}
  ; FileWrite emits ANSI bytes even for Unicode installers. The two SHA-256
  ; strings therefore occupy exactly 128 bytes, with no NUL or suffix allowed.
  StrCpy $2 $R5
  System::Call 'kernel32::GetFileType(p r2) i.r3'
  ${if} $3 != 1
    FileClose $R5
    Abort "PREVIEW registry proof is not a disk file."
  ${endif}
  System::Alloc 52
  Pop $4
  ${if} $4 == 0
    FileClose $R5
    Abort "PREVIEW cannot inspect its registry proof."
  ${endif}
  System::Call 'kernel32::GetFileInformationByHandle(p r2, p r4) i.r3'
  ${if} $3 == 0
    System::Free $4
    FileClose $R5
    Abort "PREVIEW cannot inspect its registry proof identity."
  ${endif}
  ; BY_HANDLE_FILE_INFORMATION.nNumberOfLinks is a DWORD at offset 40.
  IntOp $5 $4 + 40
  System::Call '*$5(i .r6)'
  System::Free $4
  ${if} $6 != 1
    FileClose $R5
    Abort "PREVIEW refuses a hard-linked registry proof."
  ${endif}
  ClearErrors
  FileSeek $R5 0 END $0
  ${if} ${Errors}
  ${orIf} $0 != 128
    FileClose $R5
    Abort "PREVIEW registry proof has an invalid byte length."
  ${endif}
  ClearErrors
  FileSeek $R5 0 SET
  ${if} ${Errors}
    FileClose $R5
    Abort "PREVIEW cannot rewind its registry proof."
  ${endif}
  FileRead $R5 $R8
  ${if} ${Errors}
    FileClose $R5
    Abort "PREVIEW cannot read its registry proof."
  ${endif}
  FileClose $R5
  ${if} ${Errors}
    Abort "PREVIEW cannot close its registry proof."
  ${endif}
  StrLen $0 $R8
  ${if} $0 != 128
    Abort "PREVIEW registry proof has an invalid length."
  ${endif}
  StrCpy $R9 $R8 64 64
  StrCpy $R8 $R8 64
  !insertmacro trialRegistryHashes $R6 $R7
  ${if} $R8 != $R6
  ${orIf} $R9 != $R7
    Abort "PREVIEW refuses changed registry keys."
  ${endif}
!macroend

; No production AlzabtPOS startup-registry cleanup hook.

; Compile-time inventory comes from the final prepackaged trial payload. Its
; customRemoveFiles macro removes only known files, never RMDir /r. Missing
; generated inventory fails compilation; the top-level safety barrier remains.
!ifdef BUILD_UNINSTALLER
  !include "${BUILD_RESOURCES_DIR}\trial-payload-generated.nsh"
!endif
