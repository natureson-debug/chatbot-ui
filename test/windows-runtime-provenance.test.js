const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { promisify } = require("node:util");

const executable = "C:\\AI\\llama.cpp\\llama-server.exe";
const keyFile = "C:\\AI\\config\\llama-api-key.txt";
const shell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const script = "C:\\AI\\scripts\\start-chatbot-ai.ps1";
const policy = { launcherScript: script, powershellExecutables: [shell] };
const source = fs.readFileSync(path.join(__dirname, "../core/runtime/windows.js"), "utf8");
function fixture() {
    const before = { pid: 100, parentPid: 90, createdAt: "2026-09-29T07:37:36.6288430Z", executable,
        commandLine: `"${executable}" --model C:\\AI\\models\\old.gguf --host 127.0.0.1 --port 8080 --api-key-file "${keyFile}" --ctx-size 16384 --parallel 2 --device CUDA0` };
    const parentBefore = { pid: 90, createdAt: "2026-09-29T07:37:35.2680000Z", executable: shell,
        commandLine: `"${shell}" -NoProfile -ExecutionPolicy Bypass -File "${script}"` };
    return { state: "observed", owners: [100], finalOwners: [100], before, after: { ...before },
        parentBefore, parentAfter: { ...parentBefore } };
}
function load(observation, fail = false) {
    const calls = [];
    const execFile = () => { throw Error("Unexpected callback execution"); };
    execFile[promisify.custom] = async (...args) => {
        calls.push(args);
        if (fail) throw Error("CIM unavailable");
        return { stdout: JSON.stringify(observation) };
    };
    const module = { exports: {} };
    vm.runInNewContext(source, { module, require(name) {
        if (name === "child_process") return { execFile, spawn: () => { throw Error("Lifecycle execution forbidden"); } };
        if (name === "../config") return { LLAMA_BIND_HOST: "127.0.0.1", LLAMA_PORT: 8080 };
        if (name === "../paths") return { LLAMA_EXECUTABLE: executable, API_KEY_FILE: keyFile };
        return require(name);
    } });
    return { api: module.exports, calls };
}
const cases = [
    ["exact quoted launcher and older model/context", () => {}, "eligible"],
    ["case insensitive paths", o => { o.parentBefore.commandLine = o.parentBefore.commandLine.toUpperCase(); o.parentAfter = { ...o.parentBefore }; }, "eligible"],
    ["option order", o => { o.parentBefore.commandLine = `"${shell}" -ExecutionPolicy Bypass -NoProfile -File "${script}"`; o.parentAfter = { ...o.parentBefore }; }, "eligible"],
    ["wrong directory", o => { o.parentBefore.commandLine = `"${shell}" -File C:\\evil\\start-chatbot-ai.ps1`; o.parentAfter = { ...o.parentBefore }; }, "insufficient"],
    ["backup suffix", o => { o.parentBefore.commandLine = `"${shell}" -File "${script}.bak"`; o.parentAfter = { ...o.parentBefore }; }, "insufficient"],
    ["misleading note", o => { o.parentBefore.commandLine = `"${shell}" --note="${script}"`; o.parentAfter = { ...o.parentBefore }; }, "insufficient"],
    ["command string is not File", o => { o.parentBefore.commandLine = `"${shell}" -Command echo -File "${script}"`; o.parentAfter = { ...o.parentBefore }; }, "insufficient"],
    ["old launcher", o => { o.parentBefore.commandLine = `"${shell}" -File C:\\AI\\scripts\\start-chatbot.ps1`; o.parentAfter = { ...o.parentBefore }; }, "insufficient"],
    ["direct invocation", o => { o.parentBefore.executable = "C:\\Windows\\explorer.exe"; o.parentAfter = { ...o.parentBefore }; }, "insufficient"],
    ["backend parent changed", o => { o.after.parentPid++; }, "conflicting"],
    ["parent PID changed", o => { o.parentAfter.pid++; }, "conflicting"],
    ["parent creation changed", o => { o.parentAfter.createdAt = o.before.createdAt; }, "conflicting"],
    ["parent newer by submillisecond", o => { o.parentBefore.createdAt = "2026-09-29T07:37:36.6288431Z"; o.parentAfter = { ...o.parentBefore }; }, "conflicting"],
    ["parent disappeared", o => { o.parentAfter = null; }, "insufficient"],
    ["listener changed", o => { o.finalOwners = [101]; }, "conflicting"],
    ["backend reused", o => { o.after.createdAt = "2026-09-29T07:37:37.0000000Z"; }, "conflicting"],
    ["wrong executable", o => { o.before.executable = o.after.executable = "C:\\evil.exe"; }, "insufficient"],
    ["missing creation time", o => { o.before.createdAt = o.after.createdAt = null; }, "insufficient"],
    ["key file mismatch", o => { o.before.commandLine = o.after.commandLine = o.before.commandLine.replace(keyFile, "C:\\other.txt"); }, "insufficient"],
    ["host mismatch", o => { o.before.commandLine = o.after.commandLine = o.before.commandLine.replace("127.0.0.1", "0.0.0.0"); }, "insufficient"],
    ["port mismatch", o => { o.before.commandLine = o.after.commandLine = o.before.commandLine.replace("8080", "8081"); }, "insufficient"],
    ["duplicate endpoint", o => { o.before.commandLine = o.after.commandLine = o.before.commandLine + " --port 8080"; }, "insufficient"],
    ["inline secret rejected", o => { o.before.commandLine = o.after.commandLine = o.before.commandLine + " --api-key SECRET"; }, "insufficient"],
    ["broken quoting", o => { o.parentBefore.commandLine += '"'; o.parentAfter = { ...o.parentBefore }; }, "insufficient"],
    ["absent", o => { o.state = "absent"; }, "absent"],
    ["unverifiable not absent", o => { o.state = "unverifiable"; }, "conflicting"]
];
for (const [name, mutate, expected] of cases) test(name, async () => {
    const observation = fixture(); mutate(observation);
    const { api, calls } = load(observation);
    const result = await api.assessLlamaServerProvenance(policy);
    assert.equal(result.state, expected);
    assert.ok(result.reason);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0][1][2], /Stop-Process|taskkill|Process\.Kill|TerminateProcess|ScheduledTask|schtasks/i);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|commandLine/);
});
test("invalid policy does not query", async () => {
    const { api, calls } = load(fixture());
    assert.equal((await api.assessLlamaServerProvenance({})).reason, "invalid-policy");
    assert.equal(calls.length, 0);
});
test("lookup failure is insufficient", async () => {
    assert.equal((await load(null, true).api.assessLlamaServerProvenance(policy)).reason, "lookup-failed");
});
test("paths with spaces and script arguments", async () => {
    const o = fixture();
    const spaced = "C:\\AI space\\scripts\\primary.ps1";
    o.parentBefore.commandLine = `"${shell}" -NoProfile -File "${spaced}" --note other`;
    o.parentAfter = { ...o.parentBefore };
    assert.equal((await load(o).api.assessLlamaServerProvenance({ ...policy, launcherScript: spaced })).state, "eligible");
});
test("existing PID behavior", async () => {
    assert.equal(await load({ ProcessId: 123, ExecutablePath: executable }).api.getLlamaServerPid(), 123);
    assert.equal(await load({ ProcessId: 123, ExecutablePath: "C:\\wrong.exe" }).api.getLlamaServerPid(), null);
});
test("existing identity behavior", async () => {
    const o = fixture(); o.parent = { ProcessId: 90, ExecutablePath: shell, CommandLine: o.parentBefore.commandLine };
    const identity = await load(o).api.getLlamaServerIdentity();
    assert.equal(identity.state, "verified");
    assert.equal(identity.pid, 100);
    assert.equal(identity.parent.pid, 90);
    assert.equal((await load({ state: "absent" }).api.getLlamaServerIdentity()).state, "absent");
});
