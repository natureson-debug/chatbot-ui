param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference='Stop'
$trusted=@('S-1-5-18','S-1-5-32-544')
$writeRights=[long](
    [Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership)
$writeRights=$writeRights -bor 0x40000000 -bor 0x10000000
$full=[IO.Path]::GetFullPath($Directory)
if(-not [IO.Path]::IsPathRooted($Directory) -or $full.StartsWith('\\')){throw 'Directory is not local and absolute.'}
$root=[IO.Path]::GetPathRoot($full)
if(([IO.DriveInfo]::new($root)).DriveFormat -cne 'NTFS'){throw 'Directory is not on NTFS.'}
$current=Get-Item -LiteralPath $full -Force
while($null -ne $current) {
    if(-not $current.PSIsContainer -or ($current.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Untrusted directory path.'}
    $acl=Get-Acl -LiteralPath $current.FullName
    $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if($owner -cnotin $trusted){throw 'Untrusted directory owner.'}
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
           $rule.IdentityReference.Value -cnotin $trusted -and
           (([long]$rule.FileSystemRights -band $writeRights) -ne 0)){throw 'Untrusted directory writer.'}
    }
    $current=$current.Parent
}
'protected'
