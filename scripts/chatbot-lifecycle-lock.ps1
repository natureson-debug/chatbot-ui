# Installation policy: operator SID resolved from DESKTOP-6513LCM\Admin during setup.
# Keep identical for operator and SYSTEM callers; never infer trust from the caller.
function Enter-ChatbotLifecycleLock {
    param([ValidateRange(0, 2147483647)][int]$TimeoutMilliseconds = 0)

    $mutex = $null
    $owned = $false
    try {
        $trustedSids = @('S-1-5-18', 'S-1-5-21-1162025873-2456272895-3354061701-1001')
        $security = New-Object System.Security.AccessControl.MutexSecurity
        $security.SetAccessRuleProtection($true, $false)
        foreach ($sid in $trustedSids) {
            $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)
            $rule = New-Object System.Security.AccessControl.MutexAccessRule($identity, [System.Security.AccessControl.MutexRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
            $security.AddAccessRule($rule)
        }
        $createdNew = $false
        $mutex = New-Object System.Threading.Mutex($false, 'Global\Chatbot.LlamaLifecycle', [ref]$createdNew, $security)

        # Creation security does not replace an existing object's DACL. Verify it.
        $actual = $mutex.GetAccessControl()
        $rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
        if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne $trustedSids.Count) {
            throw 'Unexpected lifecycle mutex security policy.'
        }
        foreach ($sid in $trustedSids) {
            $matching = @($rules | Where-Object {
                $_.IdentityReference.Value -eq $sid -and
                $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
                $_.MutexRights -eq [System.Security.AccessControl.MutexRights]::FullControl -and
                -not $_.IsInherited
            })
            if ($matching.Count -ne 1) { throw 'Unexpected lifecycle mutex access rule.' }
        }

        $state = 'busy'
        try {
            $owned = $mutex.WaitOne($TimeoutMilliseconds)
            if ($owned) { $state = 'acquired' }
        } catch [System.Threading.AbandonedMutexException] {
            $owned = $true
            $state = 'abandoned'
        }
        return [pscustomobject]@{ State = $state; Mutex = $mutex; Owned = $owned; Reason = $null }
    } catch {
        if ($null -ne $mutex) {
            try { if ($owned) { $mutex.ReleaseMutex() } } finally { $mutex.Dispose() }
        }
        return [pscustomobject]@{ State = 'error'; Mutex = $null; Owned = $false; Reason = 'lifecycle-lock-unavailable-or-security-mismatch' }
    }
}

function Exit-ChatbotLifecycleLock {
    param($Lock)
    if ($null -eq $Lock -or $null -eq $Lock.Mutex) { return }
    try {
        if ($Lock.Owned) { $Lock.Mutex.ReleaseMutex() }
    } finally {
        $Lock.Owned = $false
        $Lock.Mutex.Dispose()
        $Lock.Mutex = $null
    }
}
