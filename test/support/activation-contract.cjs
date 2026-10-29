"use strict";
// Pure TEST-only predicates, not an IPC endpoint, owner, lock, or process manager.
function createActivationContract({ mode, now, maxAgeMs = 2000 }) {
    if (mode !== "TEST" || typeof now !== "function") throw Error("TEST clock required");
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw Error("Invalid age");
    const result = code => Object.freeze({ mode: "TEST", code, allowed: code === "VALID", productionReady: false });
    const fresh = e => e && Number.isSafeInteger(e.at) && e.at <= now() && now() - e.at <= maxAgeMs;
    function validateRequest(request, e) {
        if (!request || !/^[a-zA-Z0-9-]{1,64}$/.test(request.operationId || "") ||
            !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
            typeof request.profileDigest !== "string" || !/^[a-f0-9]{64}$/.test(request.profileDigest)) return result("INVALID_REQUEST");
        if (!fresh(e)) return result("STALE_EVIDENCE");
        if (e.authenticatedAdmin !== true || e.sessionValid !== true || e.channelVerified !== true) return result("UNAUTHORIZED");
        if (e.lockHeld !== true || e.operationId !== request.operationId || e.replayed === true) return result("OPERATION_CONFLICT");
        if (e.revision !== request.expectedRevision || e.profileDigest !== request.profileDigest) return result("STALE_CONFIGURATION");
        if (e.qualified !== true) return result("UNQUALIFIED_PROFILE");
        if (!e.retainedHandle || e.identityVerified !== true || e.owned !== true || e.foreignListener !== false) return result("OWNERSHIP_BLOCKED");
        return result("VALID");
    }
    function validateReplacement(e, originalHandle) {
        if (!fresh(e)) return result("STALE_EVIDENCE");
        if (!originalHandle || e.retainedHandle !== originalHandle || e.identityVerified !== true || e.lockHeld !== true) return result("OWNERSHIP_BLOCKED");
        return result(e.exited === true && e.streamsClosed === true && e.listenerReleased === true ? "VALID" : "SHUTDOWN_INCOMPLETE");
    }
    function validateCompletion(request, e, launchedHandle, deadline) {
        if (!Number.isSafeInteger(deadline) || now() >= deadline) return result("STARTUP_TIMEOUT");
        if (!fresh(e)) return result("STALE_EVIDENCE");
        if (!launchedHandle || e.retainedHandle !== launchedHandle || e.identityVerified !== true ||
            e.owned !== true || e.listenerOwned !== true || e.lockHeld !== true || e.operationId !== request.operationId) return result("OWNERSHIP_BLOCKED");
        if (e.health !== "ok") return result("STARTUP_FAILED");
        if (e.revision !== request.expectedRevision || e.profileDigest !== request.profileDigest) return result("STALE_CONFIGURATION");
        if (e.loadedModelDigest !== e.expectedModelDigest || !/^[a-f0-9]{64}$/.test(e.expectedModelDigest || "") ||
            e.loadedModelPath !== e.expectedModelPath || typeof e.expectedModelPath !== "string" || !e.expectedModelPath ||
            e.modelApiIdentityVerified !== true) return result("MODEL_MISMATCH");
        return result("VALID");
    }
    return Object.freeze({ validateRequest, validateReplacement, validateCompletion });
}
module.exports = { createActivationContract };
