Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef PAYLOAD
  !error "PAYLOAD is required"
!endif
!ifndef OUTFILE
  !define OUTFILE "Banguru-Setup.exe"
!endif
!ifndef VERSION
  !define VERSION "0.1.0"
!endif
!ifndef ROOT
  !define ROOT "..\.."
!endif

Name "Banguru"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Banguru"
InstallDirRegKey HKCU "Software\Banguru" "InstallDir"
ShowInstDetails show
ShowUninstDetails show
RequestExecutionLevel user
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "Banguru"
VIAddVersionKey /LANG=2052 "CompanyName" "Nirotiy"
VIAddVersionKey /LANG=2052 "FileDescription" "Banguru WatchParty desktop client"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Copyright (c) Nirotiy"
Icon "${ROOT}\desktop-shell\electron\assets\banguru-logo.ico"
UninstallIcon "${ROOT}\desktop-shell\electron\assets\banguru-logo.ico"

!define MUI_ABORTWARNING
!define MUI_ICON "${ROOT}\desktop-shell\electron\assets\banguru-logo.ico"
!define MUI_UNICON "${ROOT}\desktop-shell\electron\assets\banguru-logo.ico"
!define MUI_WELCOMEPAGE_TITLE "安装 Banguru"
!define MUI_WELCOMEPAGE_TEXT "Banguru 安装到当前用户目录，不需要管理员权限。设置和登录状态保存在用户数据目录中。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Banguru.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动 Banguru"
!define MUI_FINISHPAGE_RUN_CHECKED

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.ProfilePageCreate un.ProfilePageLeave
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "SimpChinese"

Var un.PurgeProfileCheckbox
Var un.PurgeProfileSelected

Function .onInit
  SetShellVarContext current
FunctionEnd

Function un.onInit
  SetShellVarContext current
FunctionEnd

Section "Banguru 主程序" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*"
  WriteRegStr HKCU "Software\Banguru" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Banguru" "Version" "${VERSION}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\Banguru"
  CreateShortcut "$SMPROGRAMS\Banguru\Banguru.lnk" "$INSTDIR\Banguru.exe" "" "$INSTDIR\Banguru.exe" 0
  CreateShortcut "$SMPROGRAMS\Banguru\卸载 Banguru.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Section /o "创建桌面快捷方式" SecDesktop
  CreateShortcut "$DESKTOP\Banguru.lnk" "$INSTDIR\Banguru.exe" "" "$INSTDIR\Banguru.exe" 0
SectionEnd

Section /o "注册 watchparty:// 协议" SecProtocol
  WriteRegStr HKCU "Software\Classes\watchparty" "" "URL:Banguru WatchParty"
  WriteRegStr HKCU "Software\Classes\watchparty" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\watchparty\DefaultIcon" "" "$INSTDIR\Banguru.exe,0"
  WriteRegStr HKCU "Software\Classes\watchparty\shell\open\command" "" '"$INSTDIR\Banguru.exe" "%1"'
SectionEnd

Function un.ProfilePageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 30u "默认保留设置、登录状态和缓存。选择下面的选项会同时删除这些数据及 Banguru 在 Windows 凭据管理器中的登录凭据。"
  Pop $1
  ${NSD_CreateCheckbox} 0 42u 100% 14u "彻底删除设置、登录状态和缓存"
  Pop $un.PurgeProfileCheckbox
  nsDialogs::Show
FunctionEnd

Function un.ProfilePageLeave
  ${NSD_GetState} $un.PurgeProfileCheckbox $un.PurgeProfileSelected
FunctionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\Banguru\Banguru.lnk"
  Delete "$SMPROGRAMS\Banguru\卸载 Banguru.lnk"
  RMDir "$SMPROGRAMS\Banguru"
  Delete "$DESKTOP\Banguru.lnk"
  DeleteRegKey HKCU "Software\Classes\watchparty"

  ${If} $un.PurgeProfileSelected == ${BST_CHECKED}
    IfFileExists "$INSTDIR\BanguruCleanup.exe" 0 cleanup_missing
    DetailPrint "正在删除 Banguru 用户数据和 Windows 凭据..."
    ExecWait '"$INSTDIR\BanguruCleanup.exe" --purge-installed-profile' $0
    ${If} $0 != 0
      MessageBox MB_ICONEXCLAMATION|MB_OK "Banguru 仍在运行，或用户数据清理失败。请关闭 Banguru 后重试卸载。"
      Abort
    ${EndIf}
    Goto cleanup_done
    cleanup_missing:
      MessageBox MB_ICONEXCLAMATION|MB_OK "找不到数据清理程序，已停止卸载以避免留下不确定的登录凭据。"
      Abort
    cleanup_done:
  ${EndIf}

  DeleteRegKey HKCU "Software\Banguru"
  RMDir /r "$INSTDIR"
SectionEnd
