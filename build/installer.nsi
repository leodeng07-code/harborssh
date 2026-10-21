; A standard per-user NSIS installer. WriteUninstaller runs at install time,
; so unsigned builds can be compiled on Linux without executing Windows code.
!include "MUI2.nsh"
!include "x64.nsh"

Name "${PRODUCT_NAME}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\Harbor SSH"
InstallDirRegKey HKCU "Software\HarborSSH" "InstallDir"
ShowInstDetails show
ShowUninstDetails show
SetOverwrite on

!define MUI_ABORTWARNING
!ifndef MUI_ICON
  !define MUI_ICON "${PROJECT_DIR}/assets/icon.ico"
!endif
!ifndef MUI_UNICON
  !define MUI_UNICON "${PROJECT_DIR}/assets/icon.ico"
!endif
!define MUI_FINISHPAGE_RUN "$INSTDIR\Harbor SSH.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动 Harbor SSH"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "此版本需要 64 位 Windows。"
    Abort
  ${EndIf}
  SetRegView 64
  SetShellVarContext current
FunctionEnd

Section "Harbor SSH" Install
  SetOutPath "$INSTDIR"
  File /r "${PROJECT_DIR}/release/win-unpacked/*"
  File /oname=HarborSSH.ico "${PROJECT_DIR}/assets/icon.ico"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Harbor SSH"
  CreateShortCut "$SMPROGRAMS\Harbor SSH\Harbor SSH.lnk" "$INSTDIR\Harbor SSH.exe" "" "$INSTDIR\HarborSSH.ico"
  CreateShortCut "$SMPROGRAMS\Harbor SSH\卸载 Harbor SSH.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortCut "$DESKTOP\Harbor SSH.lnk" "$INSTDIR\Harbor SSH.exe" "" "$INSTDIR\HarborSSH.ico"
  WriteRegStr HKCU "Software\HarborSSH" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HarborSSH" "DisplayName" "Harbor SSH"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HarborSSH" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HarborSSH" "Publisher" "Harbor SSH"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HarborSSH" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HarborSSH" "DisplayIcon" "$INSTDIR\HarborSSH.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HarborSSH" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HarborSSH" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HarborSSH" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetRegView 64
  SetShellVarContext current
  Delete "$DESKTOP\Harbor SSH.lnk"
  Delete "$SMPROGRAMS\Harbor SSH\Harbor SSH.lnk"
  Delete "$SMPROGRAMS\Harbor SSH\卸载 Harbor SSH.lnk"
  RMDir "$SMPROGRAMS\Harbor SSH"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HarborSSH"
  DeleteRegKey HKCU "Software\HarborSSH"
  RMDir /r "$INSTDIR"
  ; User configuration and encrypted credentials in APPDATA are intentionally retained.
SectionEnd
