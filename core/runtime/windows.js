const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
const path = require("path");
const { LLAMA_BIND_HOST, LLAMA_PORT } = require("../config");
const { LLAMA_EXECUTABLE, API_KEY_FILE } = require("../paths");

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

// Parse Windows double-quote/backslash argument syntax; fail closed on broken quotes.
function parseWindowsArguments(commandLine) {
    if (typeof commandLine !== "string" || /[\0\r\n]/.test(commandLine)) return null;
    const args = [];
    let i = 0;
    while (i < commandLine.length) {
        while (/[ \t]/.test(commandLine[i] || "") && i < commandLine.length) i++;
        if (i === commandLine.length) break;
        let value = "", quoted = false;
        while (i < commandLine.length && (quoted || !/[ \t]/.test(commandLine[i]))) {
            let slashes = 0;
            while (commandLine[i] === "\\") { slashes++; i++; }
            if (commandLine[i] === '"') {
                value += "\\".repeat(Math.floor(slashes / 2));
                if (slashes % 2) value += '"';
                else if (quoted && commandLine[i + 1] === '"') { value += '"'; i++; }
                else quoted = !quoted;
                i++;
            } else {
                value += "\\".repeat(slashes);
                if (i < commandLine.length && (quoted || !/[ \t]/.test(commandLine[i]))) value += commandLine[i++];
            }
        }
        if (quoted) return null;
        args.push(value);
    }
    return args;
}

// Fresh read-only evidence under an explicit policy, NOT ownership or a reusable
// authorization token. Existing identity/status/restart primitives stay separate.
// policy: { launcherScript: absolutePath, powershellExecutables: [absolutePath] }
async function assessLlamaServerProvenance(policy) {
    const result = (state, reason) => ({ state, reason });
    const normalize = value => typeof value === "string" &&
        /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(value)
        ? path.win32.normalize(value).toLowerCase() : null;
    const validTime = value => typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value) &&
        Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.slice(0, 23) + "Z";
    const script = normalize(policy?.launcherScript);
    const hosts = policy?.powershellExecutables;
    if (!script || !Array.isArray(hosts) || !hosts.length || hosts.some(host => !normalize(host))) {
        return result("insufficient", "invalid-policy");
    }
    try {
        const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", `
$ErrorActionPreference = 'Stop'
function Read-Owners {
    @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection |
        Where-Object { $_.State -eq 2 -and $_.LocalAddress -eq '${LLAMA_BIND_HOST.replace(/'/g, "''")}' -and $_.LocalPort -eq ${LLAMA_PORT} } |
        Select-Object -ExpandProperty OwningProcess)
}
function Read-Instance($instanceId) {
    if ($null -eq $instanceId -or $instanceId -le 0) { return $null }
    $item = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $instanceId)
    if ($null -eq $item) { return $null }
    $created = $null
    if ($item.CreationDate -is [datetime]) {
        $created = $item.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ', [cultureinfo]::InvariantCulture)
    }
    [pscustomobject]@{ pid = $item.ProcessId; createdAt = $created; executable = $item.ExecutablePath; commandLine = $item.CommandLine; parentPid = $item.ParentProcessId }
}
$owners = @(Read-Owners)
if ($owners.Count -eq 0) { '{"state":"absent"}'; return }
if ($owners.Count -ne 1 -or $owners[0] -le 0) { '{"state":"ambiguous"}'; return }
$before = Read-Instance $owners[0]
$parentBefore = Read-Instance $before.parentPid
$parentAfter = Read-Instance $before.parentPid
$after = Read-Instance $owners[0]
$finalOwners = @(Read-Owners)
@{ state = 'observed'; owners = $owners; finalOwners = $finalOwners; before = $before; after = $after; parentBefore = $parentBefore; parentAfter = $parentAfter } | ConvertTo-Json -Depth 4 -Compress
        `], { windowsHide: true });
        const observation = JSON.parse(stdout);
        if (observation.state === "absent") return result("absent", "no-listener");
        if (observation.state !== "observed") return result("conflicting", "ambiguous-listener");
        const { owners, finalOwners, before, after, parentBefore, parentAfter } = observation;
        if (!Array.isArray(owners) || !Array.isArray(finalOwners) || owners.length !== 1 ||
            finalOwners.length !== 1 || !Number.isInteger(owners[0]) || owners[0] <= 0 ||
            owners[0] !== finalOwners[0]) return result("conflicting", "listener-changed");
        if (!before || !after) return result("conflicting", "backend-disappeared");
        if (before.pid !== owners[0] || after.pid !== owners[0] || before.createdAt !== after.createdAt ||
            before.parentPid !== after.parentPid || before.commandLine !== after.commandLine ||
            normalize(before.executable) !== normalize(after.executable)) return result("conflicting", "backend-changed");
        if (!validTime(before.createdAt) || normalize(before.executable) !== normalize(LLAMA_EXECUTABLE)) {
            return result("insufficient", "backend-unverified");
        }
        if (!parentBefore || !parentAfter) return result("insufficient", "parent-unavailable");
        if (!Number.isInteger(before.parentPid) || before.parentPid <= 0 ||
            parentBefore.pid !== before.parentPid || parentAfter.pid !== before.parentPid ||
            parentBefore.createdAt !== parentAfter.createdAt ||
            normalize(parentBefore.executable) !== normalize(parentAfter.executable) ||
            parentBefore.commandLine !== parentAfter.commandLine) return result("conflicting", "parent-changed");
        if (!validTime(parentBefore.createdAt)) return result("insufficient", "parent-time-unavailable");
        // Fixed-width UTC strings retain all seven fractional digits for ordering.
        if (parentBefore.createdAt > before.createdAt) return result("conflicting", "parent-newer-than-backend");
        if (!hosts.some(host => normalize(host) === normalize(parentBefore.executable))) {
            return result("insufficient", "untrusted-parent-executable");
        }
        const launcher = parseWindowsArguments(parentBefore.commandLine);
        if (!launcher || normalize(launcher[0]) !== normalize(parentBefore.executable)) {
            return result("insufficient", "launcher-command-unverified");
        }
        // Accept explicit, unambiguous host switches only. -File consumes the next
        // argument as the script; anything following that is a script argument.
        let trustedFile = false;
        for (let i = 1; i < launcher.length; i++) {
            const option = launcher[i].toLowerCase();
            if (option === "-file") { trustedFile = normalize(launcher[i + 1]) === script; break; }
            if (["-noprofile", "-nologo", "-noninteractive", "-noexit", "-sta", "-mta"].includes(option)) continue;
            if (option === "-executionpolicy" && /^(bypass|unrestricted|remotesigned|allsigned|restricted|default)$/i.test(launcher[i + 1] || "")) { i++; continue; }
            if (option === "-windowstyle" && /^(normal|hidden|minimized|maximized)$/i.test(launcher[i + 1] || "")) { i++; continue; }
            return result("insufficient", "unsupported-launcher-arguments");
        }
        if (!trustedFile) return result("insufficient", "untrusted-launcher-script");
        const backend = parseWindowsArguments(before.commandLine);
        if (!backend || normalize(backend[0]) !== normalize(LLAMA_EXECUTABLE)) return result("insufficient", "backend-command-unverified");
        const values = new Map();
        // Conservatively accept the primary launcher's explicit flag/value form.
        // Unknown flags/aliases are insufficient rather than guessing precedence.
        const allowed = ["--model", "--host", "--port", "--api-key-file", "--cors-origins", "--parallel", "--ctx-size", "--device"];
        for (let i = 1; i < backend.length; i += 2) {
            const flag = backend[i];
            if (!allowed.includes(flag) || values.has(flag) || !backend[i + 1] || backend[i + 1].startsWith("--")) {
                return result("insufficient", "unsupported-backend-arguments");
            }
            values.set(flag, backend[i + 1]);
        }
        if (values.get("--host") !== LLAMA_BIND_HOST || values.get("--port") !== String(LLAMA_PORT) ||
            normalize(values.get("--api-key-file")) !== normalize(API_KEY_FILE)) return result("insufficient", "backend-endpoint-mismatch");
        // Return only selected non-secret evidence, never raw command lines.
        return {
            state: "eligible",
            reason: "trusted-launcher-observed",
            backend: { pid: before.pid, createdAt: before.createdAt, executable: normalize(before.executable) },
            parent: { pid: parentBefore.pid, createdAt: parentBefore.createdAt, executable: normalize(parentBefore.executable) },
            launcherScript: script,
            listener: { host: LLAMA_BIND_HOST, port: LLAMA_PORT, owningPid: before.pid }
        };
    } catch {
        return result("insufficient", "lookup-failed");
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

module.exports = { getLlamaServerPid, restartLlamaServer, getLlamaServerIdentity, assessLlamaServerProvenance };
