param([ValidateSet('backend','application')][string]$Service)
$ErrorActionPreference='Stop'
try {
 $profile=Get-Content -Raw (Join-Path $PSScriptRoot 'profile.json')|ConvertFrom-Json
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
 $principal=New-Object Security.Principal.WindowsPrincipal($identity)
 if(!$profile.sid -or $identity.User.Value -ne $profile.sid -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'token'}
 $setting=if($Service -eq 'backend'){$profile.backend}else{$profile.application}
 $port=[int]$setting.port
 $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -eq $port)
 $name=if($Service -eq 'backend'){'llama-server.exe'}else{'node.exe'}
 $candidates=@(Get-CimInstance Win32_Process -Filter "Name='$name'" -OperationTimeoutSec 3 -ErrorAction Stop)
 if(!$listeners.Count){
  $conflicts=@($candidates|Where-Object {$Service -eq 'backend' -or !$_.CommandLine -or $_.CommandLine -match 'server\.js'})
  @{state=if($conflicts.Count){'conflict'}else{'absent'}}|ConvertTo-Json -Compress
  exit 0
 }
 if($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne $setting.host){throw 'conflict'}
 $id=$listeners[0].OwningProcess
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$id" -OperationTimeoutSec 3
 if(!$p -or !$p.ExecutablePath -or $p.ExecutablePath -ine $setting.executable -or !$p.CommandLine){throw 'identity'}
 $owner=Invoke-CimMethod -InputObject $p -MethodName GetOwner
 if(($owner.Domain+'\'+$owner.User) -ine $profile.operator){throw 'owner'}
 if($Service -eq 'backend'){
  foreach($pair in @(@('model',$setting.modelPath),@('host',$setting.host),@('port',[string]$setting.port),@('device',$setting.device),@('n-gpu-layers',[string]$setting.gpuLayers),@('ctx-size',[string]$setting.contextSize),@('parallel',[string]$setting.parallel),@('api-key-file',$setting.apiKeyFile))){
   $matches=[regex]::Matches($p.CommandLine,'(?:^|\s)--'+[regex]::Escape($pair[0])+'\s+(?:"([^"]*)"|(\S+))')
   if($matches.Count -ne 1){throw 'arguments'}
   $value=if($matches[0].Groups[1].Success){$matches[0].Groups[1].Value}else{$matches[0].Groups[2].Value}
   if($value -ine $pair[1]){throw 'arguments'}
  }
 }
 if($Service -eq 'application' -and $p.CommandLine -notmatch '(?i)(?:^|\s|\\|")server\.js(?:\s|"|$)'){throw 'application'}
 @{state='external';pid=$p.ProcessId;created=$p.CreationDate.ToUniversalTime().ToString('o');identityObserved=$true;owned=$false}|ConvertTo-Json -Compress
} catch { @{state='unverifiable'}|ConvertTo-Json -Compress; exit 1 }
