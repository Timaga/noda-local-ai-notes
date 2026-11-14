!ifndef BUILD_UNINSTALLER
  Var /GLOBAL NodaUninstallerBackup
  Var /GLOBAL NodaUninstallerTarget
  Var /GLOBAL NodaInstallCompleted

  # Upgrade with this build's uninstaller rather than executing a stale or broken
  # beta uninstaller. User data remains governed by KEEP_APP_DATA / --updated.
  Function NodaRefreshUninstaller
    ${If} $R8 == ""
      Return
    ${EndIf}
    ${IfNot} ${FileExists} "$R8\${APP_EXECUTABLE_FILENAME}"
      Return
    ${EndIf}
    ${IfNot} ${FileExists} "$R8\resources\app.asar"
      Return
    ${EndIf}
    GetFullPathName $R8 "$R8"
    ${GetRoot} "$R8" $0
    ${If} $R8 == $0
    ${OrIf} $R8 == "$0\"
      Goto NodaRepairFailed
    ${EndIf}
    System::Call 'kernel32::GetFileAttributesW(w R8)i.r0'
    IntOp $0 $0 & 0x410
    ${If} $0 != 16
      Goto NodaRepairFailed
    ${EndIf}
    StrCpy $0 "$R8\${UNINSTALL_FILENAME}"
    System::Call 'kernel32::GetFileAttributesW(w r0)i.r1'
    ${If} $1 == -1
      Goto NodaRepairFailed
    ${EndIf}
    IntOp $1 $1 & 0x410
    ${If} $1 != 0
      Goto NodaRepairFailed
    ${EndIf}
    InitPluginsDir
    StrCpy $1 "$PLUGINSDIR\noda-prior-uninstaller.exe"
    System::Call 'kernel32::CopyFileW(w r0, w r1, i 0)i.r2'
    ${If} $2 == 0
      Goto NodaRepairFailed
    ${EndIf}
    StrCpy $NodaUninstallerBackup "$1"
    StrCpy $NodaUninstallerTarget "$0"
    File /oname=$PLUGINSDIR\noda-current-uninstaller.exe "${UNINSTALLER_OUT_FILE}"
    StrCpy $1 "$PLUGINSDIR\noda-current-uninstaller.exe"
    System::Call 'kernel32::CopyFileW(w r1, w r0, i 0)i.r2'
    ${If} $2 == 0
      Goto NodaRepairFailed
    ${EndIf}
    Return
    NodaRepairFailed:
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(NodaUninstallerRepairFailed)" /SD IDOK
      SetErrorLevel 2
      Quit
  FunctionEnd

  Function NodaRestoreUninstaller
    ${If} $NodaInstallCompleted == "1"
      Return
    ${EndIf}
    ${If} $NodaUninstallerBackup == ""
      Return
    ${EndIf}
    ${If} ${FileExists} "$NodaUninstallerTarget"
      System::Call 'kernel32::CopyFileW(w "$NodaUninstallerBackup", w "$NodaUninstallerTarget", i 0)'
    ${EndIf}
  FunctionEnd
!endif
