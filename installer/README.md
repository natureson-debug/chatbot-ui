# REL-02 Windows installer source

Uses the validated REL-01B payload. REL-02B compiled successfully with the installed
Inno Setup 7.1.1 compiler; Inno Setup 6 compatibility and installed behavior remain
UNVERIFIED. The compiler reports the existing `x64` identifier as deprecated and
substitutes `x64os`. The generated installer has not been executed.

From the repository, with Inno Setup 6 installed:

```powershell
& 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe' installer\AIChatbot.iss
```

REL-02B compilation used the available per-user compiler instead:

```powershell
& "$env:LOCALAPPDATA\Programs\Inno Setup 7\ISCC.exe" installer\AIChatbot.iss
```

That compiler reports non-commercial use only; verify licensing before commercial distribution.

Expected output: `dist/installer/AIChatbot-Setup-1.0.0-win-x64.exe`.
Do not install on the production machine. Qualify install, first-run, occupied-port
refusal and uninstall preservation in a disposable Windows 11 x64 environment.

The compiler packages the existing optimized payload as-is, plus the launcher and
first-run instructions. Verify its manifest and exact file inventory before compiling;
do not substitute an unreviewed distribution. The EXE is unsigned unless separately
signed. Licensing/redistribution review remains required for public release.

Setup requests elevation only for Program Files/Start Menu/uninstall registration.
It does not execute Node, create users or application data, run the backend, install
services/tasks, or provision TLS. The shortcut runs PowerShell explicitly and invokes
Node as the interactive user. Node prerequisite detection reads version and binary
type at the standard x64 location; custom Node installations are not supported yet.

Existing destinations/registration are rejected. User data is not touched by Setup.
No recursive uninstall deletion rules target per-user storage. Installer overwrite
races, install/uninstall behavior and compiler compatibility require actual disposable
qualification; source inspection alone is not that qualification. Inno's normal
Program Files protection is assumed, not a substitute for the privileged watchdog
security design. No watchdog or inference lifecycle integration is included.
