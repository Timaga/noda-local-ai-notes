!ifndef BUILD_UNINSTALLER
  !macro customInstallMode
    StrCpy $isForceCurrentInstall "1"
  !macroend

  !macro customPageAfterChangeDir
    !define MUI_DIRECTORYPAGE_TEXT_TOP "$(NodaInstallFolder)"
    !insertmacro MUI_PAGE_DIRECTORY
  !macroend

  !macro customFinishPage
  !macroend

  !macro customInit
    StrCpy $hasPerMachineInstallation "0"
    !insertmacro setInstallModePerUser
    ${If} ${Silent}
      Call NodaCheckInstallDirectory
      ${If} $3 == 0
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
  !macroend
!endif

!define NODA_INSTALLER_REPAIR "${__FILEDIR__}\installer-repair.nsh"
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    LangString NodaUninstallerRepairFailed ${LANG_ENGLISH} "Noda could not prepare the previous installation for an update. Check folder permissions and try again."
    !include "${NODA_INSTALLER_REPAIR}"
    AutoCloseWindow true
    LangString NodaInstallFolder ${LANG_ENGLISH} "Choose a new or empty folder for Noda, or keep the current Noda installation folder."

    Function .onInstSuccess
      StrCpy $NodaInstallCompleted "1"
      ${IfNot} ${Silent}
        ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" ""
      ${EndIf}
    FunctionEnd

    Function .onGUIEnd
      Call NodaRestoreUninstaller
    FunctionEnd

    Function .onVerifyInstDir
      Call NodaCheckInstallDirectory
      ${If} $3 == 0
        Abort
      ${EndIf}
    FunctionEnd

    Function NodaCheckInstallDirectory
      StrCpy $3 0
      StrCpy $R6 "$INSTDIR"
      System::Call 'kernel32::GetFullPathNameW(w R6, i ${NSIS_MAX_STRLEN}, w .r0, p 0)i.r1'
      ${If} $1 = 0
      ${OrIf} $1 >= ${NSIS_MAX_STRLEN}
        Return
      ${EndIf}
      ${GetRoot} "$0" $1
      ${If} $1 == ""
      ${OrIf} "$0\" == $1
      ${OrIf} $0 == "$1\"
      ${OrIf} $0 == $1
        Return
      ${EndIf}

      System::Call 'kernel32::GetFileAttributesW(w r0)i.r1?e'
      Pop $2
      ${If} $1 = -1
        ${If} $2 == 2
        ${OrIf} $2 == 3
          StrCpy $3 1
        ${EndIf}
        Return
      ${EndIf}
      # Allow a regular directory. Reparse points can redirect file removal on upgrade.
      IntOp $1 $1 & 0x410
      ${If} $1 != 16
        Return
      ${EndIf}

      ReadRegStr $1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $1 != ""
        GetFullPathName $1 "$1"
        ${If} $0 == $1
        ${AndIf} ${FileExists} "$0\${APP_EXECUTABLE_FILENAME}"
        ${AndIf} ${FileExists} "$0\resources\app.asar"
          StrCpy $3 1
          Return
        ${EndIf}
      ${EndIf}

      ClearErrors
      FindFirst $1 $2 "$0\*"
      ${If} ${Errors}
        Return
      ${EndIf}
      ${Do}
        ${If} $2 != "."
        ${AndIf} $2 != ".."
          FindClose $1
          Return
        ${EndIf}
        ClearErrors
        FindNext $1 $2
      ${LoopUntil} ${Errors}
      FindClose $1
      StrCpy $3 1
    FunctionEnd
  !endif
  LangString NodaFilesInUse ${LANG_ENGLISH} "Noda's files are in use. Close Noda and run Setup again."
!macroend

!macro nodaCheckAppFile DIRECTORY
  ${If} ${FileExists} "${DIRECTORY}\${APP_EXECUTABLE_FILENAME}"
    StrCpy $0 "${DIRECTORY}\${APP_EXECUTABLE_FILENAME}"
    System::Call 'kernel32::CreateFileW(w r0, i 0x40000000, i 7, p 0, i 3, i 0, p 0)p.r0'
    ${If} $0 == -1
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(NodaFilesInUse)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r0)'
  ${EndIf}
!macroend

!macro customCheckAppRunning
  !insertmacro nodaCheckAppFile $INSTDIR
  !ifndef BUILD_UNINSTALLER
    ReadRegStr $R8 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R8 != ""
    ${AndIf} $R8 != $INSTDIR
      !insertmacro nodaCheckAppFile $R8
    ${EndIf}
    Call NodaRefreshUninstaller
  !endif
!macroend
