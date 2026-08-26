param([switch]$OpenSetup)

$ErrorActionPreference = 'Stop'
$target = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Join-Path $target 'runtime\node.exe'
$data = Join-Path $env:APPDATA 'SCREENGLO Companion'
$pidFile = Join-Path $data 'companion.pid'
$outputLog = Join-Path $data 'companion.log'
$errorLog = Join-Path $data 'companion-error.log'

if (-not (Test-Path $node)) {
  throw 'SCREENGLO Companion runtime is missing. Run the installer again from the complete extracted package.'
}

New-Item -ItemType Directory -Force -Path $data | Out-Null

if (Test-Path $pidFile) {
  try {
    $existingPid = [int](Get-Content $pidFile -Raw)
    $existing = Get-Process -Id $existingPid -ErrorAction Stop
    if ($existing.Path -eq $node) {
      Stop-Process -Id $existingPid -Force
      Start-Sleep -Milliseconds 300
    }
  } catch {}
}

# Use a simple relative argument so the space in "SCREENGLO Companion" cannot
# split server.js into an invalid command line.
$process = Start-Process -WindowStyle Hidden -FilePath $node -WorkingDirectory $target -ArgumentList @('server.js') -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog -PassThru
$ready = $false
for ($attempt = 0; $attempt -lt 24; $attempt++) {
  Start-Sleep -Milliseconds 250
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8090/pair' -TimeoutSec 1
    $status = $response.Content | ConvertFrom-Json
    if ($response.StatusCode -eq 200 -and $status.ok -and $status.url) {
      $ready = $true
      break
    }
  } catch {}
  $process.Refresh()
  if ($process.HasExited) { break }
}

if (-not $ready) {
  $detail = 'No error log was produced.'
  if (Test-Path $errorLog) {
    $tail = (Get-Content $errorLog -Tail 20) -join [Environment]::NewLine
    if ($tail.Trim()) { $detail = $tail }
  }
  throw "SCREENGLO Companion could not start.`n`n$detail`n`nLog: $errorLog"
}

if ($OpenSetup) {
  Start-Process 'http://localhost:8090/setup'
}
Write-Host 'SCREENGLO Companion is running at http://localhost:8090/setup'
