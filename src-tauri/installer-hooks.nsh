; NSIS installer hook for Termkin.
;
; Migrate users off the old "Vaulterm" install after the Vaulterm -> Termkin
; rename. Tauri installed the old app per-user at %LOCALAPPDATA%\Vaulterm, and
; NSIS keys installs by product name, so a fresh "Termkin" install would sit
; side-by-side with the old "Vaulterm" instead of replacing it. Here we run the
; old app's silent uninstaller before installing so there's no duplicate.
;
; This only removes the old *app files* (%LOCALAPPDATA%\Vaulterm). The encrypted
; vault lives elsewhere (%LOCALAPPDATA%\codework\Vaulterm) and is never touched,
; so connections and the vault carry straight over.

!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$LOCALAPPDATA\Vaulterm\uninstall.exe" 0 termkin_no_old_vaulterm
    DetailPrint "Removing the previous Vaulterm installation..."
    ExecWait '"$LOCALAPPDATA\Vaulterm\uninstall.exe" /S'
  termkin_no_old_vaulterm:
!macroend
