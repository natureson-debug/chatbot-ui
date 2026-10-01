const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
const path = require("path");
const { LLAMA_BIND_HOST, LLAMA_PORT } = require("../config");
const { LLAMA_EXECUTABLE } = require("../paths");

const execFileAsync = promisify(execFile);

async function getLlamaServerPid() {
    try {
        const { stdout } = await execFileAsync(
            "powershell.exe",
            [
                "-NoProfile",
                "-Command",
                "$ErrorActionPreference = 'Stop'; " +
                "$listeners = @(Get-NetTCPConnection -State Listen " +
                `-LocalAddress '${LLAMA_BIND_HOST.replace(/'/g, "''")}' ` +
                `-LocalPort ${LLAMA_PORT}); ` +
                "if ($listeners.Count -ne 1) { return }; " +
                "$listenerPid = $listeners[0].OwningProcess; " +
                "if ($null -eq $listenerPid -or $listenerPid -le 0) { return }; " +
                "$process = Get-CimInstance Win32_Process " +
                "-Filter ('ProcessId = ' + $listenerPid); " +
                "if ($null -eq $process) { return }; " +
                "$process | Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress"
            ],
            {
                windowsHide: true
            }
        );

        if (!stdout.trim()) return null;

        const processInfo = JSON.parse(stdout);
        const pid = processInfo?.ProcessId;
        const executable = processInfo?.ExecutablePath;

        return Number.isInteger(pid) && pid > 0 &&
            typeof executable === "string" && executable.trim() !== "" &&
            path.win32.normalize(executable).toLowerCase() ===
                path.win32.normalize(LLAMA_EXECUTABLE).toLowerCase()
            ? pid
            : null;

    } catch (error) {
        return null;
    }
}

function restartLlamaServer() {
    const child = spawn(
        "schtasks.exe",
        [
            "/Run",
            "/TN",
            "AI Chatbot - Admin Restart"
        ],
        {
            windowsHide: true,
            stdio: "ignore"
        }
    );

    child.unref();
}

module.exports = { getLlamaServerPid, restartLlamaServer };
