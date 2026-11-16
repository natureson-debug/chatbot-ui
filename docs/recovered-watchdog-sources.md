# Recovered installation sources — MP-GPU-03F-8K

On 2026-11-16 the untracked repository placeholders were replaced, byte for
byte, from the existing installation under `C:\AI\scripts`. Both inputs also
matched the retained MP-GPU-03F-8D `approved-inputs` copies byte for byte.
No historical Git provenance is claimed for these recovered implementations.

| Script | Bytes | SHA-256 (installation, retained copy and repository) |
|---|---:|---|
| start-chatbot-ai.ps1 | 12835 | 7b47891dd73e14345a16d680b47dfa45d7820bbea9a409f0ec7d97934fa25671 |
| chatbot-lifecycle-lock.ps1 | 2949 | c66831d8e8a003f8feec5447f54550f795c5cdcef3e7483436d329c79986f133 |

Original placeholders and restoration evidence were retained outside the repository:
`C:\Users\Admin\AppData\Local\Temp\MP-GPU-03F-8K-XFLDyB`.
This directory also contains the absolute-path build plan, verification report,
and `review-8k` artifact (seven scripts and one manifest). No runtime binary,
configuration contents, secrets, model, logs or recovery state are packaged.

Static parsing passed for the restored sources. Focused parse-only tests passed
32 cases, with three generated-script execution tests deliberately skipped.
The real-source v2 build succeeded without builder changes; artifact hashes and
resource mappings were checked. Default validation remains `security-unverified`.
Runtime references from the supplied plan are not native DLL qualification.

The mutex policy contains installation-specific operator SID
`S-1-5-21-1162025873-2456272895-3354061701-1001` alongside SYSTEM. Its applicability
is an outstanding portability/security review item; do not substitute identities
or claim this policy is portable. The launcher itself does not acquire this mutex.
Its original enumeration working-directory behavior is preserved in the source;
the offline builder adds the approved enumeration isolation to staged output.

Source recovery is not deployment approval. Native permissions, runtime dependency
completeness, SYSTEM access, task actions and runtime ownership still require
qualification. No script or staged artifact was executed during this recovery.
