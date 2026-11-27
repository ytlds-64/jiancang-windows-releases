Unicode true
RequestExecutionLevel user
!ifdef PORTABLE_LAUNCHER
SetCompress off
!else
SetCompressor /SOLID lzma
SetCompressorDictSize 16
!endif
CRCCheck force
ShowInstDetails show

!include "MUI2.nsh"
!include "x64.nsh"

Name "见藏 ${RELEASE_VERSION}"
!ifdef PORTABLE_LAUNCHER
OutFile "Install-JianCang.exe"
!else
OutFile "JianCang-Windows-${RELEASE_VERSION}-x64-Setup.exe"
!endif
!define MUI_ICON "jiancang.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "将为当前 Windows 用户安装或更新见藏。升级时会先关闭正在运行的已安装版本。"
!define MUI_FINISHPAGE_TEXT "见藏已安装。点击「完成」以退出安装程序。"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "启动见藏"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchJianCang
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"

VIProductVersion "${RELEASE_VERSION}.0"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "ProductName" "见藏"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "FileDescription" "见藏安装程序"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "ProductVersion" "${RELEASE_VERSION}"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "FileVersion" "${RELEASE_VERSION}"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "LegalCopyright" "见藏"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "此安装包需要 64 位 Windows。"
    SetErrorLevel 1
    Abort
  ${EndIf}
FunctionEnd

Function LaunchJianCang
  ReadEnvStr $0 "LOCALAPPDATA"
  StrCpy $0 "$0\Programs\JianCang\app-${RELEASE_VERSION}"
  IfFileExists "$0\见藏.exe" 0 failed
  SetOutPath "$0"
  ClearErrors
  ExecShell "open" "$0\见藏.exe"
  IfErrors failed
  Return
  failed:
    MessageBox MB_OK|MB_ICONEXCLAMATION "见藏已安装。请通过桌面快捷方式或开始菜单打开。"
FunctionEnd

Section "安装见藏"
  !ifdef PORTABLE_LAUNCHER
  IfFileExists "$EXEDIR\JianCang\Install-JianCang.ps1" 0 failed
  SetOutPath "$EXEDIR\JianCang"
  !define INSTALL_ARGUMENTS "-SourceDirectory $$root -ExpectedVersion '${RELEASE_VERSION}'"
  !else
  InitPluginsDir
  ClearErrors
  SetOutPath "$PLUGINSDIR\JianCang"
  IfErrors failed
  File /r "payload/*"
  IfErrors failed
  SetOutPath "$PLUGINSDIR\JianCang"
  IfErrors failed
  !define INSTALL_ARGUMENTS "-SourceDirectory $$root -ExpectedVersion '${RELEASE_VERSION}' -ExpectedListSha256 '${INSTALL_LIST_SHA256}'"
  !endif

  DetailPrint "正在校验安装文件并安装见藏…"
  ${DisableX64FSRedirection}
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "& { $$ErrorActionPreference='Stop'; $$root=[Environment]::CurrentDirectory; $$program=[IO.File]::ReadAllBytes([IO.Path]::Combine($$root,'Install-JianCang.ps1')); $$hash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($$program)).Replace('-',''); if ($$hash -ne '${SCRIPT_SHA256}') { throw '安装程序脚本校验失败。' }; & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($$program).TrimStart([char]0xFEFF))) ${INSTALL_ARGUMENTS}; exit $$LASTEXITCODE }"`
  Pop $0
  ${EnableX64FSRedirection}
  StrCmp $0 "0" done failed

  failed:
    SetErrorLevel 1
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "安装见藏失败。请重新完整解压安装文件，或使用完整的 Setup.exe 后重试。"
    Abort "安装见藏失败。请检查安装程序的错误提示后重试。"
  done:
    SetOutPath "$TEMP"
SectionEnd
