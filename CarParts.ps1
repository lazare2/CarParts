# Starts the CarParts server in the background and opens it in its own app window.
# When the window is closed the server is stopped again.
# All data lives in %APPDATA%\CarParts (outside the program folder, so updates never touch it).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$appDir = $PSScriptRoot
$base = if ($env:CARPARTS_HOME) { $env:CARPARTS_HOME } else { Join-Path $env:APPDATA 'CarParts' }
$dataDir = Join-Path $base 'data'
$backupDir = Join-Path $base 'backups'
$logDir = Join-Path $base 'logs'
$profileDir = Join-Path $base 'window'
$port = if ($env:CARPARTS_PORT) { [int]$env:CARPARTS_PORT } else { 3457 }

function Log([string]$message) {
  try {
    New-Item -ItemType Directory -Force $logDir | Out-Null
    Add-Content (Join-Path $logDir 'launcher.log') ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message)
  } catch {}
}

function Show-Error([string]$message) {
  [System.Windows.Forms.MessageBox]::Show($message, 'CarParts', 'OK', 'Error') | Out-Null
}

function Test-Server([int]$p) {
  try { return (Invoke-WebRequest "http://127.0.0.1:$p/api/catalog" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 }
  catch { return $false }
}

function Test-PortFree([int]$p) {
  try {
    $l = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), $p
    $l.Start(); $l.Stop(); return $true
  } catch { return $false }
}

try {
  $server = $null
  Log "start (port $port)"
  if (-not (Test-Server $port)) {
    # something else is using our port: take the next free one
    while (-not (Test-PortFree $port)) { $port++ }

    New-Item -ItemType Directory -Force $dataDir, $logDir | Out-Null

    # one backup copy per day, keep the last 14
    $db = Join-Path $dataDir 'carparts.db'
    if (Test-Path $db) {
      New-Item -ItemType Directory -Force $backupDir | Out-Null
      $today = Join-Path $backupDir ('carparts-{0}.db' -f (Get-Date -Format 'yyyy-MM-dd'))
      if (-not (Test-Path $today)) { Copy-Item $db $today }
      Get-ChildItem $backupDir -Filter 'carparts-*.db' | Sort-Object Name -Descending | Select-Object -Skip 14 | Remove-Item -Force
    }

    $node = Join-Path $appDir 'node.exe'
    if (-not (Test-Path $node)) {
      $found = Get-Command node -ErrorAction SilentlyContinue
      if (-not $found) { throw 'Node.js was not found. Please reinstall the app.' }
      $node = $found.Source
    }

    $env:DATA_DIR = $dataDir
    $env:PORT = "$port"
    $server = Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $appDir -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $logDir 'server.log') -RedirectStandardError (Join-Path $logDir 'server-error.log')

    Log "server started, pid $($server.Id)"
    $ready = $false
    for ($i = 0; $i -lt 80 -and -not $ready -and -not $server.HasExited; $i++) {
      Start-Sleep -Milliseconds 250
      $ready = Test-Server $port
    }
    if (-not $ready) {
      $log = Get-Content (Join-Path $logDir 'server-error.log') -Tail 8 -ErrorAction SilentlyContinue
      throw ("The program could not start.`n`n" + ($log -join "`n"))
    }
  }

  $url = "http://127.0.0.1:$port/"
  $browser = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1

  if ($browser) {
    # own window without tabs/address bar; a separate profile so we can wait until it is closed
    # (wait for the main browser process only: helper processes can linger after the window is closed)
    $window = Start-Process -FilePath $browser -PassThru -ArgumentList @(
      "--app=$url", "--user-data-dir=`"$profileDir`"", '--no-first-run', '--no-default-browser-check', '--window-size=1200,860')
    Log "window opened, pid $($window.Id)"
    $window.WaitForExit()
    Log "window closed"
    # Only the launcher that started the server cleans up. A second launch just opens another window
    # in the already running one (its browser process exits at once) and must leave everything alone.
    if ($server) {
      if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
      Get-CimInstance Win32_Process -Filter "Name='$([IO.Path]::GetFileName($browser))'" |
        Where-Object { $_.CommandLine -like "*$profileDir*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
  } else {
    Start-Process $url   # no Edge/Chrome: use the default browser and leave the server running
  }
} catch {
  Log "ERROR: $($_.Exception.Message)"
  Show-Error $_.Exception.Message
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  exit 1
}
