// No qualified ownership-aware activation provider is connected.
function blockedActivation() {
    return { state: "blocked", code: "LIFECYCLE_ACTIVATION_DISABLED", ownership: "unverified",
        error: "Activation blocked: no production-qualified lifecycle service is connected. External or unverified backends cannot be adopted or stopped. Saving configuration does not activate it. Qualify an ownership-aware model-switch interface before enabling activation." };
}
module.exports = { blockedActivation };
