# Read-only evidence collection; no effective-access safety claim.
$ErrorActionPreference = 'Stop'
$paths = @([Console]::In.ReadToEnd() | ConvertFrom-Json)
$records = @()
foreach ($target in $paths) {
    try {
        $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
        $acl = Get-Acl -LiteralPath $target -ErrorAction Stop
        $resolved = $true
        $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
        try { ([System.Security.Principal.SecurityIdentifier]$ownerSid).Translate([System.Security.Principal.NTAccount]) | Out-Null } catch { $resolved = $false }
        $entries = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
            try { $_.IdentityReference.Translate([System.Security.Principal.NTAccount]) | Out-Null } catch { $resolved = $false }
            @{ sid=$_.IdentityReference.Value; mask=[int64]$_.FileSystemRights; type=[string]$_.AccessControlType; inherited=$_.IsInherited; inheritance=[string]$_.InheritanceFlags; propagation=[string]$_.PropagationFlags }
        })
        $records += @{path=$target;state='existing';directory=[bool]$item.PSIsContainer;reparse=[bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint);ownerSid=$ownerSid;sddl=$acl.Sddl;protected=$acl.AreAccessRulesProtected;aces=$entries;principalsResolved=$resolved}
    } catch [System.Management.Automation.ItemNotFoundException] {
        $records += @{path=$target;state='missing'}
    } catch {
        $records += @{path=$target;state='unverified'}
    }
}
ConvertTo-Json -InputObject $records -Depth 6 -Compress
