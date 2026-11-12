$ErrorActionPreference='Stop'
$directorySource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\core\windows-watchdog-snapshot-directory.ps1'))
if(-not $directorySource.Contains('([IO.DriveInfo]::new($root)).DriveFormat')){throw 'Directory fixture needs review'}
$directorySource=$directorySource.Replace('([IO.DriveInfo]::new($root)).DriveFormat',"'NTFS'")
$script:mode='safe'
function Get-Item {
    $parent=[pscustomobject]@{FullName='fixture-parent';PSIsContainer=$true;Attributes=[IO.FileAttributes]::Directory;Parent=$null}
    if($script:mode -eq 'reparse'){$parent.Attributes=[IO.FileAttributes]::ReparsePoint}
    [pscustomobject]@{FullName='fixture-child';PSIsContainer=$true;Attributes=[IO.FileAttributes]::Directory;Parent=$parent}
}
function Get-Acl {
    param($LiteralPath)
    $acl=[pscustomobject]@{Target=$LiteralPath}
    $acl | Add-Member ScriptMethod GetOwner {
        param($Type)
        if($script:mode -eq 'owner' -and $this.Target -eq 'fixture-parent'){return [pscustomobject]@{Value='S-1-5-21-999'}}
        return [pscustomobject]@{Value='S-1-5-18'}
    }
    $acl | Add-Member ScriptMethod GetAccessRules {
        param($Explicit,$Inherited,$Type)
        $rules=@([pscustomobject]@{AccessControlType='Allow';IdentityReference=[pscustomobject]@{Value='S-1-5-18'};FileSystemRights=[Security.AccessControl.FileSystemRights]::FullControl})
        if($script:mode -eq 'write' -and $this.Target -eq 'fixture-parent'){
            $rules+= [pscustomobject]@{AccessControlType='Allow';IdentityReference=[pscustomobject]@{Value='S-1-1-0'};FileSystemRights=[Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles}
        }
        if($script:mode -eq 'read'){
            $rules+= [pscustomobject]@{AccessControlType='Allow';IdentityReference=[pscustomobject]@{Value='S-1-1-0'};FileSystemRights=[Security.AccessControl.FileSystemRights]::ReadAndExecute}
        }
        return $rules
    }
    $acl
}
foreach($case in @('safe','read','owner','write','reparse')) {
    $script:mode=$case
    $failed=$false
    try { $value=& ([scriptblock]::Create($directorySource)) -Directory 'C:\fixture\status' }
    catch { $failed=$true }
    if($case -in @('safe','read')) {
        if($failed -or $value -cne 'protected'){throw "Directory check rejected $case"}
    } elseif(-not $failed){throw "Directory check accepted $case"}
}

$evidenceSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\core\windows-watchdog-snapshot-evidence.ps1'))
$evidenceSource=$evidenceSource.Replace('$identity=[Security.Principal.WindowsIdentity]::GetCurrent()','$identity=Get-TestIdentity')
$original='$status=& (Join-Path $PSScriptRoot ''windows-watchdog-status.ps1'') | ConvertFrom-Json -ErrorAction Stop'
if(-not $evidenceSource.Contains($original)){throw 'Evidence fixture needs review'}
$evidenceSource=$evidenceSource.Replace($original,'$status=Get-TestStatus')
$script:identity='S-1-5-18';$script:collected=0;$script:disposed=0
function Get-TestIdentity {
    $value=[pscustomobject]@{User=[pscustomobject]@{Value=$script:identity}}
    $value | Add-Member ScriptMethod Dispose {$script:disposed++}
    $value
}
function Get-TestStatus {$script:collected++; return @{task=$null}}
$output=& ([scriptblock]::Create($evidenceSource)) | ConvertFrom-Json
if($output.identity -cne 'S-1-5-18' -or $script:collected -ne 1 -or $script:disposed -ne 1){throw 'Authorized evidence failed'}
$script:identity='S-1-5-32-544';$failed=$false
try { & ([scriptblock]::Create($evidenceSource)) } catch {$failed=$true}
if(-not $failed -or $script:collected -ne 1 -or $script:disposed -ne 2){throw 'Unauthorized producer was not rejected before collection'}
Write-Output 'PASS: mocked Windows directory trust and SYSTEM evidence checks.'
