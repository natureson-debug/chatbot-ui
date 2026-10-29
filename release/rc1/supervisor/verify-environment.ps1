param()
$ErrorActionPreference='Stop'
try{
 $profile=Get-Content -Raw (Join-Path $PSScriptRoot 'profile.json')|ConvertFrom-Json
 $me=[Security.Principal.WindowsIdentity]::GetCurrent()
 $principal=New-Object Security.Principal.WindowsPrincipal($me)
 if($me.User.Value -ne $profile.sid -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'token'}
 $rows=@(& 'C:\Windows\System32\nvidia-smi.exe' --query-gpu=index,uuid --format=csv,noheader)
 if($LASTEXITCODE -ne 0 -or !($rows|Where-Object {$_ -match ('^0,\s*'+[regex]::Escape($profile.gpuUUID)+'\s*$')})){throw 'gpu'}
 if(!(Test-Path -LiteralPath $profile.backend.modelPath -PathType Leaf)){throw 'model'}
 $config=Get-Content -Raw 'C:\AI\config\chatbot-ai-config.json'|ConvertFrom-Json
 if($config.model -cne [IO.Path]::GetFileName($profile.backend.modelPath) -or
 $config.contextSize -ne $profile.backend.contextSize -or $config.parallel -ne $profile.backend.parallel){throw 'config'}
 $acl=Get-Acl -LiteralPath $profile.backend.apiKeyFile
 foreach($entry in $acl.Access){
  $sid=$entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  if($entry.AccessControlType -eq 'Allow' -and $sid -notin @($profile.sid,'S-1-5-18')){throw 'key-acl'}
 }
 $stream=[IO.File]::OpenRead($profile.backend.apiKeyFile)
 try{if(!$stream.Length){throw 'empty-key'}}finally{$stream.Dispose()}
 '{"environmentVerified":true}'
}catch{'{"environmentVerified":false}';exit 1}
