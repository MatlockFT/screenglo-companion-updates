param(
  [switch]$OpenSetup,
  [switch]$Tray
)

$ErrorActionPreference = 'Stop'
$target = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Join-Path $target 'runtime\node.exe'
$iconPath = Join-Path $target 'screenglo.ico'
$data = Join-Path $env:APPDATA 'SCREENGLO Companion'
$pidFile = Join-Path $data 'companion.pid'
$trayPidFile = Join-Path $data 'tray.pid'
$statusFile = Join-Path $data 'update-status.json'
$outputLog = Join-Path $data 'companion.log'
$errorLog = Join-Path $data 'companion-error.log'
$script:companionProcess = $null
$script:exitRequested = $false
$script:updateStarted = $false

if (-not (Test-Path $node)) {
  throw 'SCREENGLO Companion runtime is missing. Run the installer again from the complete extracted package.'
}

New-Item -ItemType Directory -Force -Path $data | Out-Null

function Get-CompanionProcess {
  if (-not (Test-Path $pidFile)) { return $null }
  try {
    $candidatePid = [int](Get-Content $pidFile -Raw)
    $candidate = Get-Process -Id $candidatePid -ErrorAction Stop
    if ($candidate.Path -eq $node) { return $candidate }
  } catch {}
  return $null
}

function Test-CompanionReady {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8090/pair' -TimeoutSec 1
    $status = $response.Content | ConvertFrom-Json
    return $response.StatusCode -eq 200 -and $status.ok -and $status.url
  } catch { return $false }
}

function Stop-Companion {
  $existing = Get-CompanionProcess
  if ($null -ne $existing) {
    Stop-Process -Id $existing.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
  }
  Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
  $script:companionProcess = $null
}

function Start-Companion {
  param([switch]$Restart)
  if ($Restart) { Stop-Companion }
  if (Test-CompanionReady) {
    $script:companionProcess = Get-CompanionProcess
    return $true
  }

  $existing = Get-CompanionProcess
  if ($null -ne $existing) { Stop-Companion }

  # A relative server.js argument avoids quoting problems in the install path.
  $script:companionProcess = Start-Process -WindowStyle Hidden -FilePath $node -WorkingDirectory $target -ArgumentList @('server.js') -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog -PassThru
  for ($attempt = 0; $attempt -lt 32; $attempt++) {
    Start-Sleep -Milliseconds 250
    if (Test-CompanionReady) { return $true }
    $script:companionProcess.Refresh()
    if ($script:companionProcess.HasExited) { break }
  }

  $detail = 'No error log was produced.'
  if (Test-Path $errorLog) {
    $tail = (Get-Content $errorLog -Tail 20) -join [Environment]::NewLine
    if ($tail.Trim()) { $detail = $tail }
  }
  throw "SCREENGLO Companion could not start.`n`n$detail`n`nLog: $errorLog"
}

function Open-PhoneControl {
  Start-Process 'http://localhost:8090/setup'
}

function Get-UpdateState {
  try { return (Get-Content $statusFile -Raw | ConvertFrom-Json).state } catch { return '' }
}

function Set-RunningStatus {
  @{ state = 'running'; version = '0.10.1'; message = 'SCREENGLO Companion and tray are running.'; startedAt = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content -Encoding UTF8 $statusFile
}

function Start-PendingUpdate {
  $staging = Join-Path $data 'update-staging'
  $pendingFile = Join-Path $staging 'pending.json'
  $updateScript = Join-Path $target 'apply-update.ps1'
  if (-not (Test-Path $pendingFile) -or -not (Test-Path $updateScript)) { throw 'The verified update payload is missing.' }
  $pending = Get-Content $pendingFile -Raw | ConvertFrom-Json
  $version = [string]$pending.version
  if (-not $version) { throw 'The pending update version is missing.' }
  $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$updateScript`" -StagingPath `"$staging`" -Version `"$version`""
  Start-Process -FilePath $powerShell -ArgumentList $arguments -WindowStyle Hidden | Out-Null
}

if (-not $Tray) {
  $null = Start-Companion
  if ($OpenSetup) { Open-PhoneControl }
  Write-Host 'SCREENGLO Companion is running at http://localhost:8090/setup'
  exit 0
}

$trayMutex = New-Object -TypeName System.Threading.Mutex -ArgumentList @($false, 'Local\SCREENGLOCompanionTray')
$ownsMutex = $false
try { $ownsMutex = $trayMutex.WaitOne(0, $false) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
if (-not $ownsMutex) {
  if ($OpenSetup) { Open-PhoneControl }
  $trayMutex.Dispose()
  exit 0
}

Set-Content -Encoding ASCII -Path $trayPidFile -Value $PID
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$trayImage = New-Object System.Drawing.Icon -ArgumentList $iconPath
$notifyIcon.Icon = $trayImage
$notifyIcon.Text = 'SCREENGLO Companion - Starting'
$notifyIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'Open Phone Control'
$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'Restart Companion'
$logsItem = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'Open Logs Folder'
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'Exit SCREENGLO'
$separator = New-Object System.Windows.Forms.ToolStripSeparator
$menu.Items.Add($openItem) | Out-Null
$menu.Items.Add($restartItem) | Out-Null
$menu.Items.Add($logsItem) | Out-Null
$menu.Items.Add($separator) | Out-Null
$menu.Items.Add($exitItem) | Out-Null
$notifyIcon.ContextMenuStrip = $menu

$openItem.add_Click({ Open-PhoneControl })
$notifyIcon.add_DoubleClick({ Open-PhoneControl })
$logsItem.add_Click({ Start-Process $data })
$restartItem.add_Click({
  try {
    $notifyIcon.Text = 'SCREENGLO Companion - Restarting'
    $null = Start-Companion -Restart
    $notifyIcon.Text = 'SCREENGLO Companion - Running'
    $notifyIcon.ShowBalloonTip(1800, 'SCREENGLO', 'Companion restarted and Phone Control is ready.', [System.Windows.Forms.ToolTipIcon]::Info)
  } catch {
    $notifyIcon.Text = 'SCREENGLO Companion - Needs attention'
    $notifyIcon.ShowBalloonTip(3500, 'SCREENGLO could not restart', $_.Exception.Message, [System.Windows.Forms.ToolTipIcon]::Error)
  }
})
$exitItem.add_Click({
  $script:exitRequested = $true
  Stop-Companion
  $notifyIcon.Visible = $false
  [System.Windows.Forms.Application]::ExitThread()
})

$healthTimer = $null
try {
  try {
    $null = Start-Companion
    $notifyIcon.Text = 'SCREENGLO Companion - Running'
    Set-RunningStatus
    if ($OpenSetup) { Open-PhoneControl }
    $notifyIcon.ShowBalloonTip(1600, 'SCREENGLO is running', 'Phone Control is available on your home network.', [System.Windows.Forms.ToolTipIcon]::Info)
  } catch {
    $notifyIcon.Text = 'SCREENGLO Companion - Needs attention'
    @{ state = 'failed'; version = '0.10.1'; message = $_.Exception.Message; failedAt = (Get-Date).ToString('o') } |
      ConvertTo-Json | Set-Content -Encoding UTF8 $statusFile
    $notifyIcon.ShowBalloonTip(3500, 'SCREENGLO needs attention', 'Right-click the tray icon to retry or open the logs.', [System.Windows.Forms.ToolTipIcon]::Warning)
  }

  $healthTimer = New-Object System.Windows.Forms.Timer
  $healthTimer.Interval = 5000
  $healthTimer.add_Tick({
    if ($script:exitRequested) { return }
    if ((Get-UpdateState) -eq 'installing') {
      $notifyIcon.Text = 'SCREENGLO Companion - Updating'
      if (-not $script:updateStarted) {
        try {
          $script:updateStarted = $true
          Start-PendingUpdate
        } catch {
          @{ state = 'failed'; version = ''; message = "Could not launch the updater: $($_.Exception.Message)"; failedAt = (Get-Date).ToString('o') } |
            ConvertTo-Json | Set-Content -Encoding UTF8 $statusFile
        }
      }
      return
    }
    $script:updateStarted = $false
    if (Test-CompanionReady) {
      $notifyIcon.Text = 'SCREENGLO Companion - Running'
      return
    }
    try {
      $notifyIcon.Text = 'SCREENGLO Companion - Recovering'
      $null = Start-Companion
      $notifyIcon.Text = 'SCREENGLO Companion - Running'
      Set-RunningStatus
    } catch {
      $notifyIcon.Text = 'SCREENGLO Companion - Needs attention'
    }
  })
  $healthTimer.Start()
  [System.Windows.Forms.Application]::Run()
} finally {
  if ($null -ne $healthTimer) { $healthTimer.Stop(); $healthTimer.Dispose() }
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  $trayImage.Dispose()
  $menu.Dispose()
  try {
    if ((Test-Path $trayPidFile) -and ([int](Get-Content $trayPidFile -Raw)) -eq $PID) {
      Remove-Item -Force $trayPidFile -ErrorAction SilentlyContinue
    }
  } catch {}
  if ($ownsMutex) { $trayMutex.ReleaseMutex() }
  $trayMutex.Dispose()
}
