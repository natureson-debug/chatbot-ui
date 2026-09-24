const { spawn, execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

async function getLlamaServerPid() {
    try {
        const { stdout } = await execFileAsync(
            "powershell.exe",
            [
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_Process | " +
                "Where-Object { $_.Name -eq 'llama-server.exe' } | " +
                "Select-Object -First 1 -ExpandProperty ProcessId)"
            ],
            {
                windowsHide: true
            }
        );

        const pid = Number(stdout.trim());

        return Number.isInteger(pid) && pid > 0
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
