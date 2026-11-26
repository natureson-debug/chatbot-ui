; REL-02: compile with Inno Setup 6. No installation performed during development.
#define Payload "..\dist\AIChatbot-1.0.0-win-x64-optimized"
#if !FileExists(Payload + "\packaging-manifest.json")
  #error Optimized payload is missing. Build and validate REL-01B first.
#endif

[Setup]
AppId={{69E483CA-A98F-4E23-A600-DA190844C478}
AppName=AIChatbot
AppVersion=1.0.0
VersionInfoVersion=1.0.0.0
VersionInfoDescription=AIChatbot Windows Setup
VersionInfoProductName=AIChatbot
VersionInfoProductVersion=1.0.0
DefaultDirName={commonpf64}\AIChatbot
DisableDirPage=yes
UsePreviousAppDir=no
DefaultGroupName=AIChatbot
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
MinVersion=10.0.22000
OutputDir=..\dist\installer
OutputBaseFilename=AIChatbot-Setup-1.0.0-win-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
Uninstallable=yes
InfoAfterFile=FIRST-RUN.txt

[Files]
Source: "{#Payload}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "Start-AIChatbot.ps1"; DestDir: "{app}"
Source: "FIRST-RUN.txt"; DestDir: "{app}"

[Icons]
Name: "{group}\AIChatbot"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Start-AIChatbot.ps1"""; WorkingDir: "{app}"
Name: "{group}\First-run instructions"; Filename: "{app}\FIRST-RUN.txt"
Name: "{group}\Uninstall AIChatbot"; Filename: "{uninstallexe}"

; Deliberately no Run, Tasks, Registry or UninstallDelete sections.
; Per-user data is never installed or deleted by Setup.
[Code]
function GetBinaryType(lpApplicationName: String; var lpBinaryType: Cardinal): Boolean;
  external 'GetBinaryTypeW@kernel32.dll stdcall';

function NodeAvailable(): Boolean;
var
  FileName, Version: String;
  BinaryType: Cardinal;
begin
  FileName := ExpandConstant('{commonpf64}\nodejs\node.exe');
  Result := FileExists(FileName);
  if Result then Result := GetVersionNumbersString(FileName, Version);
  if Result then Result := Pos('24.', Version) = 1;
  if Result then Result := GetBinaryType(FileName, BinaryType);
  if Result then Result := BinaryType = 6; { SCS_64BIT_BINARY }
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if DirExists(ExpandConstant('{app}')) or FileExists(ExpandConstant('{app}')) then
    Result := 'AIChatbot destination already exists. Upgrade handling is not implemented. Setup will not overwrite it. Review the existing installation and preserve user data before proceeding.'
  else if RegKeyExists(HKLM64, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{69E483CA-A98F-4E23-A600-DA190844C478}_is1') then
    Result := 'An AIChatbot installation is already registered. Repair/upgrade is not supported by this installer.'
  else if not NodeAvailable() then
    Result := 'Install official Node.js 24 x64 in Program Files\nodejs, then run Setup again. Node.js is not bundled or downloaded by this installer.';
end;
