param(
  [Parameter(Mandatory = $true)][string]$StagingPath,
  [Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = 'Stop'
$target = Split-Path -Parent $MyInvocation.MyCommand.Path
$data = Join-Path $env:APPDATA 'SCREENGLO Companion'
$expectedStaging = Join-Path $data 'update-staging'
$statusFile = Join-Path $data 'update-status.json'
$pidFile = Join-Path $data 'companion.pid'
$startScript = Join-Path $target 'start.ps1'

try {
  $resolvedStaging = [IO.Path]::GetFullPath($StagingPath).TrimEnd('\')
  $resolvedExpected = [IO.Path]::GetFullPath($expectedStaging).TrimEnd('\')
  if ($resolvedStaging -ne $resolvedExpected -or -not (Test-Path (Join-Path $resolvedStaging 'pending.json'))) {
    throw 'The staged update location is invalid.'
  }

  if (Test-Path $pidFile) {
    try {
      $companionPid = [int](Get-Content $pidFile -Raw)
      for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (-not (Get-Process -Id $companionPid -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 250
      }
    } catch {}
  }

  Get-ChildItem -Path $resolvedStaging -Recurse -File | Where-Object { $_.Name -ne 'pending.json' } | ForEach-Object {
    $relative = $_.FullName.Substring($resolvedStaging.Length).TrimStart('\')
    if ($relative.Contains('..')) { throw 'The update contains an invalid path.' }
    $destination = Join-Path $target $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -Force $_.FullName $destination
  }

  Get-ChildItem -Path $target -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $resolvedStaging
  @{ state = 'installed'; version = $Version; message = "Updated successfully to $Version."; installedAt = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -Encoding UTF8 $statusFile
  & $startScript
} catch {
  @{ state = 'failed'; version = $Version; message = $_.Exception.Message; failedAt = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -Encoding UTF8 $statusFile
  throw
}
