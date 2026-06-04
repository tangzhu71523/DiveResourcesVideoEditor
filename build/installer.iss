; DiveEdit Inno Setup installer.
;
; Build: iscc build/installer.iss
; Output: build/Output/DiveEdit-Setup-<version>.exe
;
; Release shape:
;   1. PyInstaller produces dist/DiveEdit/ via build/dive_edit.spec.
;   2. Inno Setup wraps that onedir app into one setup.exe.
;   3. Runtime/model bootstrap runs during setup on an Inno progress page.
;      PowerShell stays hidden; setup status text is updated from bootstrap.
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
UsePreviousAppDir=no
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
InfoBeforeFile=setup-space-notice.txt

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
; Frozen app, output of `pyinstaller build/dive_edit.spec`.
Source: "..\dist\DiveEdit\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

; Bootstrap helpers, needed only during install / first run.
Source: "bootstrap.ps1";        DestDir: "{app}\setup"; Flags: ignoreversion
Source: "download_model.py";    DestDir: "{app}\setup"; Flags: ignoreversion
Source: "setup-space-notice.txt"; DestDir: "{app}\setup"; Flags: ignoreversion

; Bundle ffmpeg when the release build machine has the standard local install.
; This prevents clean machines from blocking on a separate ~100MB ffmpeg download.
#ifexist "C:\ffmpeg\bin\ffmpeg.exe"
Source: "C:\ffmpeg\bin\ffmpeg.exe"; DestDir: "{app}\bin"; Flags: ignoreversion
#endif
#ifexist "C:\ffmpeg\bin\ffprobe.exe"
Source: "C:\ffmpeg\bin\ffprobe.exe"; DestDir: "{app}\bin"; Flags: ignoreversion
#endif

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[InstallDelete]
; Ensure upgrades do not keep stale bundled frontend/config/native files from
; earlier builds. Models and user job data are outside {app}, so this is safe.
Type: filesandordirs; Name: "{app}\_internal"
Type: files; Name: "{app}\{#MyAppExeName}"

[UninstallDelete]
; Keep model cache and per-user app data so reinstall is fast. Remove only
; binaries that this installer owns under the install directory.
Type: filesandordirs; Name: "{app}\bin"

[Code]
const
  WAIT_OBJECT_0 = 0;
  WAIT_TIMEOUT = $00000102;
  SEE_MASK_NOCLOSEPROCESS = $00000040;

type
  TShellExecuteInfo = record
    cbSize: DWORD;
    fMask: Cardinal;
    Wnd: HWND;
    lpVerb: string;
    lpFile: string;
    lpParameters: string;
    lpDirectory: string;
    nShow: Integer;
    hInstApp: THandle;
    lpIDList: DWORD;
    lpClass: string;
    hkeyClass: THandle;
    dwHotKey: DWORD;
    hMonitor: THandle;
    hProcess: THandle;
  end;

function ShellExecuteEx(var lpExecInfo: TShellExecuteInfo): BOOL;
  external 'ShellExecuteExW@shell32.dll stdcall';
function WaitForSingleObject(Handle: THandle; Milliseconds: Cardinal): Cardinal;
  external 'WaitForSingleObject@kernel32.dll stdcall';
function GetExitCodeProcess(Process: THandle; var ExitCode: Cardinal): BOOL;
  external 'GetExitCodeProcess@kernel32.dll stdcall';
function TerminateProcess(Process: THandle; ExitCode: Cardinal): BOOL;
  external 'TerminateProcess@kernel32.dll stdcall';
function CloseHandle(Handle: THandle): BOOL;
  external 'CloseHandle@kernel32.dll stdcall';
function GetProcessId(Process: THandle): DWORD;
  external 'GetProcessId@kernel32.dll stdcall';

var
  BootstrapExec: TShellExecuteInfo;
  BootstrapRunning: Boolean;

procedure StopBootstrapProcessTree;
var
  ProcessId: Cardinal;
  ResultCode: Integer;
begin
  ProcessId := GetProcessId(BootstrapExec.hProcess);
  if ProcessId <> 0 then
  begin
    if not Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /PID ' + IntToStr(ProcessId), '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      TerminateProcess(BootstrapExec.hProcess, 1);
  end
  else
    TerminateProcess(BootstrapExec.hProcess, 1);
end;

function ReadBootstrapStatus(StatusPath: string): string;
var
  Text: AnsiString;
begin
  Result := '';
  if FileExists(StatusPath) then
  begin
    LoadStringFromFile(StatusPath, Text);
    Result := Trim(Text);
  end;
end;

function ReadBootstrapProgress(ProgressPath: string): Integer;
var
  Text: AnsiString;
begin
  Result := -1;
  if FileExists(ProgressPath) then
  begin
    LoadStringFromFile(ProgressPath, Text);
    Result := StrToIntDef(Trim(Text), -1);
    if Result < 0 then
      Result := -1;
    if Result > 100 then
      Result := 100;
  end;
end;

procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if BootstrapRunning then
  begin
    Confirm := False;
    if MsgBox('Cancel DiveEdit runtime preparation and exit Setup?', mbConfirmation, MB_YESNO) = IDYES then
    begin
      StopBootstrapProcessTree;
      Cancel := True;
    end
    else
      Cancel := False;
  end;
end;

procedure RunBootstrapOnProgressPage;
var
  ProgressPage: TOutputProgressWizardPage;
  Params: string;
  StatusPath: string;
  ProgressPath: string;
  StatusText: string;
  LastStatusText: string;
  ProgressValue: Integer;
  WaitResult: Cardinal;
  ExitCode: Cardinal;
  Tick: Integer;
  PowerShellExe: string;
begin
  StatusPath := ExpandConstant('{tmp}\diveedit-bootstrap.status');
  ProgressPath := StatusPath + '.progress';
  DeleteFile(StatusPath);
  DeleteFile(ProgressPath);
  SaveStringToFile(StatusPath, 'Starting DiveEdit runtime preparation...', False);
  SaveStringToFile(ProgressPath, '0', False);

  Params :=
    '-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "' +
    ExpandConstant('{app}\setup\bootstrap.ps1') + '" -InstallDir "' +
    ExpandConstant('{app}') + '" -LogDir "' +
    ExpandConstant('{commonappdata}\DiveEdit\logs') + '" -StatusPath "' +
    StatusPath + '"';

  BootstrapExec.cbSize := SizeOf(BootstrapExec);
  BootstrapExec.fMask := SEE_MASK_NOCLOSEPROCESS;
  BootstrapExec.Wnd := 0;
  BootstrapExec.lpVerb := '';
  PowerShellExe := ExpandConstant('{win}\Sysnative\WindowsPowerShell\v1.0\powershell.exe');
  if not FileExists(PowerShellExe) then
    PowerShellExe := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  if not FileExists(PowerShellExe) then
    PowerShellExe := 'powershell.exe';
  BootstrapExec.lpFile := PowerShellExe;
  BootstrapExec.lpParameters := Params;
  BootstrapExec.lpDirectory := ExpandConstant('{app}');
  BootstrapExec.nShow := SW_HIDE;

  ProgressPage := CreateOutputProgressPage(
    'Preparing DiveEdit runtime',
    'Setup is preparing required video tools and AI assets.');
  WizardForm.CancelButton.Visible := True;
  WizardForm.CancelButton.Enabled := True;
  WizardForm.CancelButton.Caption := 'Cancel';
  ProgressPage.SetText(
    'Starting runtime preparation...',
    'You can cancel anytime. Logs: C:\ProgramData\DiveEdit\logs\setup-bootstrap.log');
  ProgressPage.SetProgress(0, 100);
  ProgressPage.Show;

  if not ShellExecuteEx(BootstrapExec) then
  begin
    ProgressPage.Hide;
    ProgressPage.Free;
    RaiseException('Failed to start DiveEdit runtime preparation.');
  end;

  BootstrapRunning := True;
  Tick := 0;
  LastStatusText := '';
  try
    while True do
    begin
      WaitResult := WaitForSingleObject(BootstrapExec.hProcess, 0);
      WizardForm.CancelButton.Visible := True;
      WizardForm.CancelButton.Enabled := True;
      StatusText := ReadBootstrapStatus(StatusPath);
      if (StatusText <> '') and (StatusText <> LastStatusText) then
      begin
        LastStatusText := StatusText;
        ProgressPage.SetText(StatusText, 'You can cancel anytime. Logs: C:\ProgramData\DiveEdit\logs\setup-bootstrap.log');
      end;

      ProgressValue := ReadBootstrapProgress(ProgressPath);
      if ProgressValue >= 0 then
        ProgressPage.SetProgress(ProgressValue, 100)
      else
      begin
        Tick := (Tick + 2) mod 100;
        ProgressPage.SetProgress(Tick, 100);
      end;

      if WaitResult = WAIT_OBJECT_0 then
        break;
      if WaitResult <> WAIT_TIMEOUT then
        RaiseException('Error while waiting for DiveEdit runtime preparation.');

      Sleep(200);
    end;

    GetExitCodeProcess(BootstrapExec.hProcess, ExitCode);
    if ExitCode <> 0 then
      RaiseException('DiveEdit runtime preparation failed. See C:\ProgramData\DiveEdit\logs\setup-bootstrap.log');

    ProgressPage.SetText('DiveEdit runtime is ready.', '');
    ProgressPage.SetProgress(100, 100);
    Sleep(1000);
  finally
    BootstrapRunning := False;
    CloseHandle(BootstrapExec.hProcess);
    ProgressPage.Hide;
    ProgressPage.Free;
    DeleteFile(StatusPath);
    DeleteFile(ProgressPath);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    RunBootstrapOnProgressPage;
end;
