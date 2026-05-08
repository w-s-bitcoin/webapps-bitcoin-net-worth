$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 8081
$HostAddr = "127.0.0.1"
$Url = "http://$HostAddr`:$Port/"

Set-Location $ScriptDir

Write-Host "Starting Bitcoin Net Worth Tracker on $Url"

$usePyLauncher = $false
$pythonExe = $null
if (Get-Command py -ErrorAction SilentlyContinue) {
  $usePyLauncher = $true
  $pythonExe = "py"
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
  $pythonExe = "python"
} else {
  Write-Host "Python was not found. Install Python 3 and retry."
  Read-Host "Press Enter to close"
  exit 1
}

${apiUrl} = "${Url}api/live-history/files"

function Test-TrackerApi {
  param([string]$Target)
  try {
    Invoke-WebRequest -Uri $Target -UseBasicParsing -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

if (Test-TrackerApi -Target $apiUrl) {
  Write-Host "Tracker server is already running. Opening app..."
  Start-Process $Url
  exit 0
}

if ($usePyLauncher) {
  $serverProc = Start-Process -FilePath "py" -ArgumentList @("-3", "$ScriptDir\standalone_server.py", "--host", $HostAddr, "--port", "$Port", "--root", $ScriptDir) -PassThru
} else {
  $serverProc = Start-Process -FilePath "python" -ArgumentList @("$ScriptDir\standalone_server.py", "--host", $HostAddr, "--port", "$Port", "--root", $ScriptDir) -PassThru
}

Write-Host "Waiting for server to be ready..."
$ready = $false
for ($i = 0; $i -lt 80; $i++) {
  if (Test-TrackerApi -Target $apiUrl) {
    $ready = $true
    break
  }
  Start-Sleep -Milliseconds 100
}

if ($ready) {
  Start-Process $Url
} else {
  Write-Host "Server did not become ready in time."
}

if ($serverProc) {
  Wait-Process -Id $serverProc.Id
}
