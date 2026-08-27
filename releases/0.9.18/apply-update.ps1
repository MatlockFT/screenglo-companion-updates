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
$backupPath = Join-Path $data 'update-backup'

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
      $remaining = Get-Process -Id $companionPid -ErrorAction SilentlyContinue
      if ($remaining -and $remaining.Path -eq (Join-Path $target 'runtime\node.exe')) {
        Stop-Process -Id $companionPid -Force
        Start-Sleep -Milliseconds 300
      }
    } catch {}
  }

  Remove-Item -Recurse -Force $backupPath -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $backupPath | Out-Null
  $updateFiles = Get-ChildItem -Path $resolvedStaging -Recurse -File | Where-Object { $_.Name -ne 'pending.json' }
  $updateFiles | ForEach-Object {
    $relative = $_.FullName.Substring($resolvedStaging.Length).TrimStart('\')
    if ($relative.Contains('..')) { throw 'The update contains an invalid path.' }
    $destination = Join-Path $target $relative
    if (Test-Path $destination) {
      $backup = Join-Path $backupPath $relative
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backup) | Out-Null
      Copy-Item -Force $destination $backup
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -Force $_.FullName $destination
  }

  Get-ChildItem -Path $target -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
  & $startScript
  Remove-Item -Recurse -Force $resolvedStaging
  Remove-Item -Recurse -Force $backupPath
  @{ state = 'installed'; version = $Version; message = "Updated successfully to $Version."; installedAt = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -Encoding UTF8 $statusFile
} catch {
  $failure = $_.Exception.Message
  if (Test-Path $backupPath) {
    Get-ChildItem -Path $backupPath -Recurse -File | ForEach-Object {
      $relative = $_.FullName.Substring($backupPath.Length).TrimStart('\')
      $destination = Join-Path $target $relative
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
      Copy-Item -Force $_.FullName $destination
    }
    try { & $startScript } catch {}
  }
  @{ state = 'rolled_back'; version = $Version; message = "Update failed and the previous version was restored: $failure"; failedAt = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -Encoding UTF8 $statusFile
  throw
}
