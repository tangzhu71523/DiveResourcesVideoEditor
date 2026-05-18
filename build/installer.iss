; DiveEdit Inno Setup installer.
;
; Build: iscc build/installer.iss
; Output: build/Output/DiveEdit-Setup-<version>.exe
;
; Release shape:
;   1. PyInstaller produces dist/DiveEdit/ via build/dive_edit.spec.
;   2. Inno Setup wraps that onedir app into one setup.exe.
;   3. After install, setup runs bootstrap.ps1 hidden. The user sees the
;      normal installer progress page, not a PowerShell window.
;   4. Customer machines do not need system Python or a virtual environment.
;      DiveEdit.exe contains Python and the packaged dependencies.
;   5. Default install path is Program Files, but the wizard always shows a
;      Browse-enabled destination page.

#define MyAppName "DiveEdit"
#define MyAppVersion "0.1.1"
#define MyAppPublisher "Diveresources"
#define MyAppExeName "DiveEdit.exe"

[Setup]
AppId={{D1V3-ED1T-0001-0000-000000000001}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableDirPage=no
DisableProgramGroupPage=yes
OutputDir=Output
OutputBaseFilename=DiveEdit-Setup-{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=..\assets\diveedit.ico
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"
Name: "downloadmodels"; Description: "Prepare video tools, CUDA runtime, and AI speech model now (recommended)"; GroupDescription: "First-run setup:"

[Files]
; Frozen app, output of `pyinstaller build/dive_edit.spec`.
Source: "..\dist\DiveEdit\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

; Bootstrap helpers, needed only during install / first run.
Source: "bootstrap.ps1";        DestDir: "{app}\setup"; Flags: ignoreversion
Source: "download_model.py";    DestDir: "{app}\setup"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; Post-install bootstrap. RunHidden keeps customer install free of black boxes.
Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NoProfile -File ""{app}\setup\bootstrap.ps1"" -InstallDir ""{app}"" -LogDir ""{commonappdata}\DiveEdit\logs"""; \
  StatusMsg: "Preparing DiveEdit runtime and AI speech model. First install may take several minutes..."; \
  Flags: runhidden waituntilterminated; \
  Tasks: downloadmodels

; Optional final launch.
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; \
  Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Keep model cache and per-user app data so reinstall is fast. Remove only
; binaries that this installer owns under the install directory.
Type: filesandordirs; Name: "{app}\bin"
