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

// Read-only evidence, never termination authority. An absent listener does not
// prove that starting is safe. Optional commandLine/parent fields may be null.
// createdAt preserves the UTC CIM timestamp as an ISO string (7 decimal places).
async function getLlamaServerIdentity() {
    const unverifiable = reason => ({ state: "unverifiable", reason });
    const normalize = value => typeof value === "string" && value.trim()
        ? path.win32.normalize(value).toLowerCase() : null;
    // Never expose command lines containing inline API-key arguments.
    const safeCommandLine = value => typeof value === "string" &&
        !/--api-key(?!-file)\b|LLAMA_API_KEY\s*=/i.test(value) ? value : null;
    const validTime = value => typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value) &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString() === value.slice(0, 23) + "Z";

    try {
        const { stdout } = await execFileAsync("powershell.exe", [
            "-NoProfile", "-Command",
            `$ErrorActionPreference = 'Stop'
function Read-Listener {
    @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection |
        Where-Object { $_.State -eq 2 -and $_.LocalAddress -eq '${LLAMA_BIND_HOST.replace(/'/g, "''")}' -and $_.LocalPort -eq ${LLAMA_PORT} } |
        Select-Object -ExpandProperty OwningProcess)
}
function Read-Backend($ownerId) {
    $item = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $ownerId)
    if ($null -eq $item) { return $null }
    $created = $null
    if ($item.CreationDate -is [datetime]) {
        $created = $item.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ', [cultureinfo]::InvariantCulture)
    }
    [pscustomobject]@{ pid = $item.ProcessId; createdAt = $created; executable = $item.ExecutablePath; commandLine = $item.CommandLine; parentPid = $item.ParentProcessId }
}
$owners = @(Read-Listener)
if ($owners.Count -eq 0) { '{"state":"absent"}'; return }
if ($owners.Count -ne 1 -or $owners[0] -le 0) { '{"state":"unverifiable","reason":"ambiguous-listener"}'; return }
$before = Read-Backend $owners[0]
$parent = $null
if ($null -ne $before -and $before.parentPid -gt 0) {
    try {
        $parent = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $before.parentPid) |
            Select-Object ProcessId, ExecutablePath, CommandLine
    } catch { $parent = $null }
}
$after = Read-Backend $owners[0]
$finalOwners = @(Read-Listener)
@{ state = 'observed'; owners = $owners; finalOwners = $finalOwners; before = $before; after = $after; parent = $parent } | ConvertTo-Json -Depth 4 -Compress`
        ], { windowsHide: true });

        const result = JSON.parse(stdout);
        if (result.state === "absent") return { state: "absent" };
        if (result.state !== "observed") return unverifiable("ambiguous-listener");
        const { owners, finalOwners, before, after, parent } = result;
        if (!Array.isArray(owners) || !Array.isArray(finalOwners) ||
            owners.length !== 1 || finalOwners.length !== 1 ||
            !Number.isInteger(owners[0]) || owners[0] <= 0 ||
            owners[0] !== finalOwners[0]) return unverifiable("listener-changed");
        if (!before || !after || before.pid !== owners[0] || after.pid !== owners[0]) {
            return unverifiable("process-unavailable");
        }
        if (normalize(before.executable) !== normalize(LLAMA_EXECUTABLE) ||
            normalize(after.executable) !== normalize(LLAMA_EXECUTABLE)) {
            return unverifiable("executable-mismatch");
        }
        if (!validTime(before.createdAt) || !validTime(after.createdAt)) {
            return unverifiable("creation-time-unavailable");
        }
        if (before.createdAt !== after.createdAt) return unverifiable("process-changed");

        return {
            state: "verified",
            pid: before.pid,
            createdAt: before.createdAt,
            executable: normalize(before.executable),
            listener: { host: LLAMA_BIND_HOST, port: LLAMA_PORT, owningPid: owners[0] },
            commandLine: safeCommandLine(before.commandLine),
            parent: {
                pid: Number.isInteger(before.parentPid) && before.parentPid > 0 ? before.parentPid : null,
                executable: parent?.ProcessId === before.parentPid ? normalize(parent.ExecutablePath) : null,
                commandLine: parent?.ProcessId === before.parentPid ? safeCommandLine(parent.CommandLine) : null
            }
        };
    } catch (error) {
        return unverifiable("lookup-failed");
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

module.exports = { getLlamaServerPid, restartLlamaServer, getLlamaServerIdentity };
