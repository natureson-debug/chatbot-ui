param([Parameter(Mandatory=$true)][string]$TestPath)
$ErrorActionPreference='Stop'
# Disposable paths only. No ACL changes and no production integration.
$full=[IO.Path]::GetFullPath($TestPath)
$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
if (!$full.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase)) { throw 'Disposable TEMP path required' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FixtureAccessCheck {
 [StructLayout(LayoutKind.Sequential)] public struct Mapping { public uint Read,Write,Execute,All; }
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateToken(IntPtr token,int level,out IntPtr duplicate);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool AccessCheck(byte[] descriptor,IntPtr token,uint desired,ref Mapping mapping,IntPtr privileges,ref uint length,out uint granted,out bool allowed);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static uint Check(byte[] descriptor,IntPtr token) {
  IntPtr duplicate=IntPtr.Zero,buffer=IntPtr.Zero;
  try {
   if(!DuplicateToken(token,2,out duplicate))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
   var mapping=new Mapping{Read=0x120089,Write=0x120116,Execute=0x1200A0,All=0x1F01FF};
   uint size=4096,granted;bool allowed;buffer=Marshal.AllocHGlobal((int)size);
   if(!AccessCheck(descriptor,duplicate,0x02000000,ref mapping,buffer,ref size,out granted,out allowed))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
   return allowed?granted:0;
  } finally {if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);if(duplicate!=IntPtr.Zero)CloseHandle(duplicate);}
 }
}
'@
try {
 $item=Get-Item -LiteralPath $full -Force
 if(!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Fixture directory required'}
 $acl=Get-Acl -LiteralPath $full
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
 try {$mask=[FixtureAccessCheck]::Check($acl.GetSecurityDescriptorBinaryForm(),$identity.Token)}finally{$identity.Dispose()}
 [pscustomobject]@{status='SECURITY_UNVERIFIED';scope='current-token-only';nativeAccessCheck=$true;grantedMask=$mask;createFile=[bool]($mask-band 2);createDirectory=[bool]($mask-band 4);delete=[bool]($mask-band 65536);deleteChild=[bool]($mask-band 64);writeDac=[bool]($mask-band 262144);writeOwner=[bool]($mask-band 524288);reason='Unrelated identities and ancestor replacement not qualified'}|ConvertTo-Json -Compress
}catch{[pscustomobject]@{status='SECURITY_UNVERIFIED';nativeAccessCheck=$false;reason='Fixture or native check unavailable';errorType=$_.Exception.GetType().Name}|ConvertTo-Json -Compress}
