# Isolated signed watchdog snapshot (MP-GPU-03D)

This prototype is **not wired to a scheduled task, watchdog, API, or UI** and
has no default snapshot path or key. Nothing is scheduled or activated by
importing its module. The existing read-only status route and fail-closed
ownership/configuration diagnostic are unchanged.

## Trust boundary and data flow

1. A separately authorized SYSTEM process invokes the producer library. The
   fixed evidence script checks its Windows token SID is `S-1-5-18`, then calls
   the existing read-only collector and ownership diagnostic. It does not call
   watchdog recovery or take a lifecycle lock.
2. The producer selects only normalized task and backend fields; unknown,
   unverified or inconsistent values fail closed. It signs the UTF-8 payload
   bytes with Ed25519 using a private key supplied by trusted integration code.
3. Before collecting and before writing, the Windows directory checker requires
   an absolute local NTFS directory, rejects reparse points in its ancestor
   chain, requires SYSTEM or Administrators ownership at each level, and rejects
   allow ACEs granting write/delete/ACL or ownership rights to other SIDs.
   The checker is deliberately conservative; it does not change any ACL.
   A unique exclusive temporary file is flushed and renamed over the destination
   in the same directory; errors are reported and do not request recovery.
4. The consumer reads at most 16 KiB plus one byte from a single open file,
   verifies its signature with an independently pinned public key, strictly
   validates the payload and freshness, then overlays only task and backend
   fields onto an independently sampled existing status. Missing, invalid,
   untrusted or stale snapshots leave that status unchanged with a fixed reason.

The signature covers the exact payload bytes, not a reserialized JSON object.
Filesystem permissions alone do not authenticate a JSON identity claim. The
private key must be restricted to the trusted producer and the public key pin
must come from separately protected configuration, **not the snapshot directory**.
The prototype accepts key objects or PEM input from trusted local code; it does
not implement secure key provisioning, rotation, or an OS keystore integration.
Do not pass a private key through a command line or store it in the repository.
Injection points for collection, directory checking and writing are for isolated
tests and trusted local integration only; never expose them or the producer as
an HTTP endpoint or arbitrary privileged command interface.

## Version 1 contract

The JSON file is exactly `{ "version": 1, "payload": "<base64>",
"signature": "<base64>" }`. The payload is UTF-8 JSON, and the signature is
the 64-byte Ed25519 signature of those exact bytes. Both strings use canonical
base64. The signed payload is specified in
[watchdog-snapshot-v1.schema.json](./watchdog-snapshot-v1.schema.json).
The implementation additionally enforces canonical valid UTC timestamps,
signature validity, exact property sets, size, and cross-field consistency.

`collectedAt` is UTC with milliseconds. `producer.verified` asserts that the
producer checked the SYSTEM SID; the pinned signature authenticates that
assertion only under the trust assumptions below. A task may be unavailable
with an allowlisted reason independently of the backend. A backend is either
verified with a positive PID and a verified matched/mismatched comparison, or
has null verification, comparison and PID with an allowlisted reason. No raw
command lines, arguments, API keys, exceptions or configuration contents are
included. The independent unverified listener PID is never included in the
signed payload.

Freshness is computed by the consumer, not asserted by the producer: max age
120 seconds, at most 5 seconds future clock skew, with `{ageMs,maxAgeMs}` returned
alongside the signed timestamp. Expired and future snapshots are rejected.
When integrating, keep this timestamp and freshness separate from the fallback
sample's timestamp, and recheck freshness at response/display time; do not cache
verified fields beyond the snapshot deadline.

## Required separate production integration

1. Review the design and threat model; provision and protect a signing key and
   independent public-key pin. Protect all producer scripts, runtime modules,
   dependencies, and their parent directories against untrusted modification.
   Confirm SYSTEM can use the key and the non-elevated UI account cannot.
2. Separately provision a local NTFS destination and restricted ACLs, with UI
   read access only, and independently audit directory, file, ancestor and key
   permissions. The checker may reject common Windows root ACLs; resolve this
   during an approved infrastructure review, not by weakening the check.
3. Qualify collection, atomic replacement, key access, signed-file reading,
   task semantics, clock behavior and failures on the target Windows version
   under the real identities, using a non-production destination. Confirm the
   watchdog's timing and single-writer behavior. No tests here qualify SYSTEM
   access or real ACL inheritance.
4. Only with separate approval, invoke the producer from an authorized SYSTEM
   context and opt the existing admin-only route into the consumer. Display the
   signed collection time and stale/unavailable status separately. Do not rely
   on the existing sample cache for snapshot freshness. Preserve current
   authorization, read-only behavior, polling and fallback.

## Rollback and limitations

Disable the separately introduced producer invocation and consumer opt-in;
the existing direct status collector remains the fallback. Revoke or rotate
the key if compromise is suspected. Retire the snapshot under the approved
maintenance procedure; never treat it as backend lifecycle authority.

The design trusts SYSTEM, administrators, the protected producer code, key
custody, the public-key pin, and the host clock. A compromised trusted process
can sign false evidence; signatures cannot establish that the collection code
was honestly executed. An attacker able to replace/delete a snapshot can cause
denial of service or replay a genuine snapshot within the freshness window.
Clock rollback can extend apparent freshness; there is no persistent monotonic
sequence or rollback protection. Evidence is sampled and may change immediately
after verification. Directory checks and file operations are not a single
handle-relative transaction, so ancestor/ACL races require trusted directory
administration; the signature limits forgery but cannot prevent denial of
service. NTFS ACL evaluation is conservative and real-machine qualification,
including hard links, inheritance and locked-file replacement, is still required.
Atomic rename is not a guarantee of persistence after power loss. Snapshots must
never drive recovery, stopping processes, or other privileged actions.
