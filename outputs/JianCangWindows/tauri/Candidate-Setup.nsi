Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
CRCCheck force

!include "MUI2.nsh"
!include "x64.nsh"

!ifdef PRODUCTION
  !define PRODUCT "见藏"
  !define INSTALL_DIR "$LOCALAPPDATA\Programs\JianCang-WebView2"
  !define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\JianCang.WebView2"
  !define CLOSE_MODE " -Production"
!else
  !define PRODUCT "见藏 Tauri ${RELEASE_VERSION} 测试版"
  !define INSTALL_DIR "$LOCALAPPDATA\Programs\JianCang-Tauri-Candidate-${RELEASE_VERSION}"
  !define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\JianCang.Tauri.Candidate.${RELEASE_VERSION}"
  !define CLOSE_MODE ""
!endif
!define WEBVIEW2_KEY "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define STARTUP_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define STARTUP_APPROVAL_KEY "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
!define STARTUP_NAME "JianCang.WebView2"

Name "${PRODUCT}"
OutFile "Local-Setup.exe"
InstallDir "${INSTALL_DIR}"
VIProductVersion "${RELEASE_VERSION}.0"

!define MUI_ICON "installer.ico"
!define MUI_UNICON "installer.ico"
!define MUI_WELCOMEPAGE_TEXT "将为当前 Windows 用户单独安装${PRODUCT}。"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "启动${PRODUCT}"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchCandidate
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "ProductName" "${PRODUCT}"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "FileDescription" "${PRODUCT}安装程序"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "FileVersion" "${RELEASE_VERSION}"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "LegalCopyright" "见藏"

!macro CheckReplaceable FILE FAILURE
  ${If} ${FileExists} "${FILE}"
    ClearErrors
    FileOpen $0 "${FILE}" a
    IfErrors ${FAILURE}
    FileClose $0
  ${EndIf}
!macroend

!macro RunCandidateHelper OPERATION FAILURE
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  ClearErrors
  File /oname=Close-Candidate.ps1 "Close-Candidate.ps1"
  IfErrors ${FAILURE}
  nsExec::ExecToLog /TIMEOUT=55000 `"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "& { $$ErrorActionPreference='Stop'; $$bytes=[IO.File]::ReadAllBytes([IO.Path]::Combine([Environment]::CurrentDirectory,'Close-Candidate.ps1')); $$hash=[Security.Cryptography.SHA256]::Create(); try { $$digest=[BitConverter]::ToString($$hash.ComputeHash($$bytes)).Replace('-','').ToLowerInvariant() } finally { $$hash.Dispose() }; if ($$digest -cne '${CLOSE_SCRIPT_SHA256}') { throw 'Installer helper verification failed.' }; & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($$bytes))) '${RELEASE_VERSION}' '${OPERATION}'${CLOSE_MODE}; exit 0 }"`
  Pop $0
  StrCmp $0 "0" +2
  Goto ${FAILURE}
!macroend

!macro CloseCandidate OPERATION FAILURE
  DetailPrint "正在关闭已安装的${PRODUCT}…"
  !insertmacro RunCandidateHelper "${OPERATION}" ${FAILURE}
!macroend

!macro CheckProductionSetup BUSY
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Global\JianCang.WebView2.Setup") p.r0 ?e'
  Pop $1
  StrCmp $0 0 ${BUSY}
  StrCmp $1 183 ${BUSY}
!macroend

Function .onInit
  SetShellVarContext current
  StrCpy $INSTDIR "${INSTALL_DIR}"
  ${IfNot} ${RunningX64}
    SetErrorLevel 1
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "此安装包需要 64 位 Windows。"
    Abort
  ${EndIf}

  SetRegView 32
  ReadRegStr $0 HKLM "${WEBVIEW2_KEY}" "pv"
  StrCmp $0 "" check_user
  StrCmp $0 "0.0.0.0" 0 have_webview
  check_user:
    ReadRegStr $0 HKCU "${WEBVIEW2_KEY}" "pv"
    StrCmp $0 "" missing_webview
    StrCmp $0 "0.0.0.0" missing_webview have_webview
  missing_webview:
    SetErrorLevel 2
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "此版本需要 Microsoft Edge WebView2 Runtime。请从微软官网安装 WebView2 Runtime，再运行本安装程序。"
    Abort
  have_webview:
  !ifdef PRODUCTION
    !insertmacro CheckProductionSetup setup_busy
    Return
    setup_busy:
      SetErrorLevel 5
      IfSilent +2
      MessageBox MB_OK|MB_ICONSTOP "见藏正在安装或卸载。请稍后再试。"
      Abort
  !endif
FunctionEnd

Function LaunchCandidate
  ExecShell "open" "$INSTDIR\jiancang-tauri.exe" "" SW_SHOWNORMAL
FunctionEnd

!ifdef PRODUCTION
Section "安装见藏"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\production-payload"
  ClearErrors
  File /r "payload/*"
  IfErrors install_failed
  WriteUninstaller "$PLUGINSDIR\production-payload\Uninstall.exe"
  IfErrors install_failed
  SetOutPath "$PLUGINSDIR"
  File /oname=Close-Candidate.ps1 "Close-Candidate.ps1"
  File /oname=Install-Production.ps1 "Install-Production.ps1"
  IfErrors install_failed
  nsExec::ExecToLog `"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "& { $$ErrorActionPreference='Stop'; function Read-Helper($$name,$$expected) { $$bytes=[IO.File]::ReadAllBytes([IO.Path]::Combine([Environment]::CurrentDirectory,$$name)); $$hash=[Security.Cryptography.SHA256]::Create(); try { $$digest=[BitConverter]::ToString($$hash.ComputeHash($$bytes)).Replace('-','').ToLowerInvariant() } finally { $$hash.Dispose() }; if ($$digest -cne $$expected) { throw 'Installer helper verification failed.' }; return [scriptblock]::Create([Text.Encoding]::UTF8.GetString($$bytes)) }; $$close=Read-Helper 'Close-Candidate.ps1' '${CLOSE_SCRIPT_SHA256}'; & (Read-Helper 'Install-Production.ps1' '${INSTALL_SCRIPT_SHA256}') '${RELEASE_VERSION}' $$close; exit 0 }"`
  Pop $0
  StrCmp $0 "0" installed
  StrCmp $0 "4" older_version
  install_failed:
    SetErrorLevel 1
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "无法安装见藏。请检查安装详情，或先退出正在运行的见藏后重试。"
    Abort
  older_version:
    SetErrorLevel 4
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "当前已安装较新的见藏。请使用更新版本的安装包。"
    Abort
  installed:
    SetOutPath "$INSTDIR"
SectionEnd
!else
Section "安装见藏 Tauri 测试版"
  !insertmacro CloseCandidate "install" close_failed
  !insertmacro CheckReplaceable "$INSTDIR\jiancang-tauri.exe" failed
  !insertmacro CheckReplaceable "$INSTDIR\backend\node.exe" failed
  ClearErrors
  SetOutPath "$INSTDIR"
  File /r "payload/*"
  IfErrors failed
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  IfErrors failed
  CreateShortCut "$SMPROGRAMS\${PRODUCT}.lnk" "$INSTDIR\jiancang-tauri.exe"
  IfErrors failed
  CreateShortCut "$DESKTOP\${PRODUCT}.lnk" "$INSTDIR\jiancang-tauri.exe"
  IfErrors failed
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${RELEASE_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\jiancang-tauri.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  IfErrors failed done
  close_failed:
    SetErrorLevel 3
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "无法自动关闭见藏 Tauri 测试版，或安装位置已变化。请退出测试版后重试。"
    Abort
  failed:
    SetErrorLevel 1
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "安装失败。请退出正在运行的见藏 Tauri 测试版并重试。"
    Abort
  done:
SectionEnd
!endif

Function un.onInit
  SetShellVarContext current
  SetRegView 32
  StrCmp $INSTDIR "${INSTALL_DIR}" 0 invalid_dir
  !ifdef PRODUCTION
    !insertmacro CheckProductionSetup setup_busy
  !endif
  Return
  !ifdef PRODUCTION
    setup_busy:
      SetErrorLevel 5
      IfSilent +2
      MessageBox MB_OK|MB_ICONSTOP "见藏正在安装或卸载。请稍后再试。"
      Abort
  !endif
  invalid_dir:
    SetErrorLevel 1
    Abort
FunctionEnd

Section "Uninstall"
  !insertmacro CloseCandidate "uninstall" failed
  !insertmacro CheckReplaceable "$INSTDIR\jiancang-tauri.exe" failed
  !insertmacro CheckReplaceable "$INSTDIR\backend\node.exe" failed
  ClearErrors
  !include "remove-payload.nsh"
  IfFileExists "$INSTDIR\jiancang-tauri.exe" failed
  IfFileExists "$INSTDIR\backend\node.exe" failed
  !ifdef PRODUCTION
    !insertmacro RunCandidateHelper "remove-shortcuts" shortcut_cleanup_failed
    Goto unregister
    shortcut_cleanup_failed:
      DetailPrint "无法清理部分见藏快捷方式。"
    unregister:
    SetRegView 64
    ReadRegStr $0 HKCU "${STARTUP_RUN_KEY}" "${STARTUP_NAME}"
    StrCmp $0 "" clear_startup_approval
    StrCmp $0 '$\"$INSTDIR\jiancang-tauri.exe$\"' 0 startup_cleanup_done
    DeleteRegValue HKCU "${STARTUP_RUN_KEY}" "${STARTUP_NAME}"
    clear_startup_approval:
    DeleteRegValue HKCU "${STARTUP_APPROVAL_KEY}" "${STARTUP_NAME}"
    startup_cleanup_done:
    SetRegView 32
  !else
    Delete "$SMPROGRAMS\${PRODUCT}.lnk"
    Delete "$DESKTOP\${PRODUCT}.lnk"
  !endif
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Goto done
  failed:
    SetErrorLevel 1
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "无法卸载当前的${PRODUCT}。请检查安装版本并退出见藏后重试。"
    Abort
  done:
SectionEnd
