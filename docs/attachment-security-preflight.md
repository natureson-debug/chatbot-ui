# MP-07.2B-2B-S2 — security inspection boundary

Standalone `inspectAttachmentStorage(absoluteWindowsPath)` is asynchronous and
read-only. It is not integrated with startup or attachment operations. Drive-rooted
paths only are supported; UNC/device namespaces fail closed. The PowerShell
collector has a 15-second timeout and 1 MiB output limit, uses stdin for literal
paths, and performs only Get-Item/Get-Acl and principal translation. It inspects
each ancestor, ownership, raw DACL masks, inheritance flags and reparse attributes.
No contents are read, directories created, or ACLs modified. Results include paths
and security descriptors for administrator diagnostics only; do not expose them
through ordinary-user endpoints or indiscriminate logging.

## Status rules

- STORAGE_ROOT_UNSAFE: confirmed reparse/non-directory component, or trusted
  effective-access evidence confirms unrelated mutation/replacement authority.
- SECURITY_UNVERIFIED: missing directory (firstMissing identifies the first),
  inaccessible ancestor/ACL, unresolved principal, incomplete group/effective-access
  evidence, invalid path or inspection failure. Existing ancestors' DACLs are
  returned for inheritance-risk review, not as a guarantee of future child ACLs.
- STORAGE_ROOT_QUALIFIED: every existing component has complete matching evidence,
  trusted ownership and no unrelated effective mutation rights.

## Explicit implementation limitation — not deployment qualified

The Windows collector does **not** implement AuthzAccessCheck/AccessCheck or enumerate
all relevant local/domain identities and transitive group memberships. Therefore
its default path never returns QUALIFIED based on ACL entries alone. It also does
not label a broad Allow ACE conclusively unsafe without effective-access evidence:
deny entries, token restrictions and inheritance semantics matter.

`assessEffectiveAccess` is an injected trusted qualification interface, used only
by deterministic tests at present. It must bind proof to the exact path/SDDL and
cover ownership, groups, deny/allow evaluation, write/delete/delete-child,
WRITE_DAC/WRITE_OWNER and ancestor replacement authority. No HTTP/client-supplied
proofs may be accepted. Simulated QUALIFIED/UNSAFE results are not Windows effective
access validation. A native Windows effective-access implementation and independent
qualification are still needed to fulfill the full S2 objective.

Next stage: implement a read-only native access-check provider with an explicit
trusted SID set and complete identity/group scope; unknown/domain-unavailable
coverage must remain UNVERIFIED. Qualify using disposable Windows ACL fixtures,
including deny entries and inheritance. Then inspect the intended provisioned
root under the deployment identity. Do not enable per-user mode as part of this.

Inspection is a point-in-time observation, not atomic enforcement against directory
replacement. No protection is claimed against malicious same-account processes,
administrators or SYSTEM. TOCTOU remains. No permissions or migration are automated.
