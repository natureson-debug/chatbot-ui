# S3 native Windows access-check feasibility

The test-only PowerShell/C# PInvoke experiment is
`test/support/native-access-check-poc.ps1 -TestPath <disposable TEMP directory>`.
It reads one real security descriptor and duplicates the current Windows token
to an impersonation token, then calls AccessCheck(MAXIMUM_ALLOWED) with file
GENERIC_MAPPING. Handles and unmanaged buffers are released. It never changes an
ACL, opens application data, or returns STORAGE_ROOT_QUALIFIED. No dependency was
installed. Windows PowerShell/.NET/advapi32/kernel32 are sufficient. Execution used
a process-local ExecutionPolicy Bypass, with no persistent policy change.

Observed non-elevated sandbox account: CodexSandboxOffline. Native result for a
fresh inherited-ACL TEMP directory: mask 1507775; create file/directory, DELETE and
WRITE_DAC granted; DELETE_CHILD and WRITE_OWNER not granted. This is evidence for
that token only, not an unrelated-user vulnerability. Missing child path returned
SECURITY_UNVERIFIED. The disposable directory was removed. No retained binary.

Requested private-owner, broad Authenticated Users Modify, writable-ancestor,
read-only unrelated-account and unreadable/unresolved-principal fixture matrix:
UNVERIFIED. No alternate account tokens were available in this experiment and no
ACL provisioning was performed. The inherited TEMP fixture is not substituted for
those cases. The POC is not hardened against malicious TEMP ancestor replacement;
its caller must supply a disposable controlled fixture. It is not an inspector
for arbitrary production paths or proof of complete filesystem access semantics.

## Recommendation

Prefer a protected-directory deployment policy with an explicit trusted SID set
(application owner, SYSTEM, administrators) and no unrelated mutation grants.
Use native AccessCheck with real representative tokens to qualify fixtures and
diagnose permissions. Do not implement a general ACL evaluator. AuthzAccessCheck
with AuthzInitializeContextFromToken is an alternative for reusable authorization
contexts. SID-derived Authz contexts are less complete and may fail domain group
resolution; they cannot justify universal unrelated-user denial.

The existing S2 collector cannot establish token group/deny-only/restricted SID
semantics, privilege effects, ownership trust, or complete unrelated-identity
coverage. Its injected booleans are only a test seam. Owner trust must be configured
explicitly, not inferred from account names. Unresolved memberships remain
UNVERIFIED, not denied. ACE ordering and inheritance must be evaluated natively.

Directory replacement analysis needs both target DELETE and parent DELETE_CHILD,
plus creation rights, and WRITE_DAC/WRITE_OWNER escalation paths. A retained
directory handle opened using CreateFileW with BACKUP_SEMANTICS and
OPEN_REPARSE_POINT, followed by GetSecurityInfo and reparse/file identity checks,
is preferable to separate pathname observations. Inspect every ancestor; opening
the final reparse point does not prevent traversal through earlier junctions.
These are point-in-time observations, not TOCTOU elimination. Same-account malware,
administrators and SYSTEM are outside the proposed protection boundary.

## Work estimate and deployment gates

Narrow native evidence adapter plus bounded protocol and handle cleanup: roughly
2–4 engineering days; disposable multi-account ACL qualification and review:
another 2–4 days (estimates, not commitments). Universal arbitrary domain identity
qualification is open-ended and should not be the goal. Obtaining other users'
real tokens requires authorized logon/session access; do not request credentials
or elevation implicitly. Current-token checking only needs readable descriptors
and query/duplicate rights on one's own token.

Next: approve a finite trusted-identity deployment policy and separate disposable
fixture ACL provisioning with a dedicated unrelated test account. Qualify native
allow/deny, inheritance, ownership and parent replacement results before any
production storage provisioning. No startup integration, storage-mode changes or
migration are authorized here.

References:
- https://learn.microsoft.com/windows/win32/api/securitybaseapi/nf-securitybaseapi-accesscheck
- https://learn.microsoft.com/en-us/windows/win32/api/authz/nf-authz-authzinitializecontextfromsid
- https://learn.microsoft.com/en-us/windows/win32/secauthz/initializing-a-client-context
- https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-point-operations
- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea
