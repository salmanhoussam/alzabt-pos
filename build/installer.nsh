; Alzabt POS — custom NSIS hooks (included by electron-builder via build.nsis.include).
;
; On a real uninstall, remove the per-user auto-start entry the app registered with
; app.setLoginItemSettings({ name: "AlzabtPOS" }) — see src/main/autoStart.ts.
; Skipped during an upgrade (the old version is uninstalled silently by the new installer), so an
; update never switches auto-start off behind the merchant's back.
;
; The sales ledger in %APPDATA%\Alzabt POS is deliberately NOT deleted: it is the merchant's
; financial record.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AlzabtPOS"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "AlzabtPOS"
  ${endIf}
!macroend
