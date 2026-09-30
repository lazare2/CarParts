# Installs CarParts for the current user (no admin rights needed):
#   - program files  -> %LOCALAPPDATA%\Programs\CarParts   (safe to reinstall/update any time)
#   - your data      -> %APPDATA%\CarParts\data            (never touched by install/uninstall)
#   - Desktop + Start Menu shortcuts named "ავტონაწილები" with the wheel icon
#
# Two ways it runs:
#   Install.bat            from a copy of the repository (needs Node.js 22.13+ once, it is copied into the app)
#   CarParts-Setup.exe     built by build-setup.ps1, everything is bundled inside (-Payload)
param(
  [string]$Payload,      # zip with the ready-made app (used by CarParts-Setup.exe)
  [string]$StageTo,      # only assemble the app files into this folder and stop (used by build-setup.ps1)
  [string]$InstallDir = $(if ($env:CARPARTS_INSTALL_DIR) { $env:CARPARTS_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\CarParts' }),
  [string]$DesktopDir = $(if ($env:CARPARTS_DESKTOP_DIR) { $env:CARPARTS_DESKTOP_DIR } else { [Environment]::GetFolderPath('Desktop') }),
  [string]$StartMenuDir = $(if ($env:CARPARTS_STARTMENU_DIR) { $env:CARPARTS_STARTMENU_DIR } else { Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' }),
  [switch]$NoLaunch,
  [switch]$Quiet         # no popups (for testing)
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
if ($env:CARPARTS_QUIET) { $Quiet = $true; $NoLaunch = $true }   # for automated tests

$appName = 'ავტონაწილები'
$repo = Split-Path -Parent $PSScriptRoot
$dataBase = if ($env:CARPARTS_HOME) { $env:CARPARTS_HOME } else { Join-Path $env:APPDATA 'CarParts' }
$dataDir = Join-Path $dataBase 'data'

function Say([string]$message, [string]$icon = 'Information') {
  if ($Quiet) { Write-Host $message } else { [System.Windows.Forms.MessageBox]::Show($message, $appName, 'OK', $icon) | Out-Null }
}

# copy the app out of a repository checkout into $dest
function Copy-AppFiles([string]$dest) {
  $nodeSource = Join-Path $repo 'node.exe'
  if (-not (Test-Path $nodeSource)) {
    $found = Get-Command node -ErrorAction SilentlyContinue
    if (-not $found) { throw "Node.js was not found.`nInstall it from https://nodejs.org (version 22.13 or newer) and run Install.bat again." }
    $nodeSource = $found.Source
  }
  $version = [version](& $nodeSource --version).TrimStart('v')
  if ($version -lt [version]'22.13') { throw "Node.js $version is too old. Please install version 22.13 or newer from https://nodejs.org." }

  New-Item -ItemType Directory -Force $dest | Out-Null
  $publicDest = Join-Path $dest 'public'
  if (Test-Path $publicDest) { Remove-Item $publicDest -Recurse -Force }
  foreach ($f in 'server.js', 'db.js', 'package.json', 'CarParts.ps1') { Copy-Item (Join-Path $repo $f) $dest -Force }
  Copy-Item (Join-Path $repo 'public') $publicDest -Recurse -Force
  Copy-Item (Join-Path $PSScriptRoot 'carparts.ico') $dest -Force
  Copy-Item (Join-Path $PSScriptRoot 'uninstall.ps1') $dest -Force
  Copy-Item $nodeSource (Join-Path $dest 'node.exe') -Force
}

function New-Shortcut([string]$path, [string]$icon) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $InstallDir 'CarParts.ps1')`""
  $lnk.WorkingDirectory = $InstallDir
  $lnk.IconLocation = "$icon,0"
  $lnk.WindowStyle = 7
  $lnk.Description = $appName
  $lnk.Save()
}

try {
  if ($StageTo) { Copy-AppFiles $StageTo; return }

  # a running copy would keep its files locked
  $installedNode = Join-Path $InstallDir 'node.exe'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $installedNode } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500

  # program files
  if ($Payload) {
    New-Item -ItemType Directory -Force $InstallDir | Out-Null
    $publicDest = Join-Path $InstallDir 'public'
    if (Test-Path $publicDest) { Remove-Item $publicDest -Recurse -Force }
    Expand-Archive -Path $Payload -DestinationPath $InstallDir -Force
  } else {
    Copy-AppFiles $InstallDir
  }

  # data: keep what is there; on the very first install take over the database of a repository checkout
  $migrated = $false
  $oldDb = Join-Path $repo 'data\carparts.db'
  if (-not (Test-Path (Join-Path $dataDir 'carparts.db')) -and -not $Payload -and (Test-Path $oldDb)) {
    New-Item -ItemType Directory -Force $dataDir | Out-Null
    Copy-Item $oldDb (Join-Path $dataDir 'carparts.db')
    $migrated = $true
  }

  # shortcuts (desktop + start menu) and the entry in Windows "Installed apps"
  $icon = Join-Path $InstallDir 'carparts.ico'
  New-Item -ItemType Directory -Force $DesktopDir, $StartMenuDir | Out-Null
  New-Shortcut (Join-Path $DesktopDir "$appName.lnk") $icon
  New-Shortcut (Join-Path $StartMenuDir "$appName.lnk") $icon

  $version = (Get-Content (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json).version
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CarParts'
  New-Item -Path $key -Force | Out-Null
  $entries = @{
    DisplayName = "$appName (CarParts)"; DisplayVersion = $version; Publisher = 'CarParts'
    DisplayIcon = $icon; InstallLocation = $InstallDir
    UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $InstallDir 'uninstall.ps1')`""
  }
  foreach ($k in $entries.Keys) { Set-ItemProperty -Path $key -Name $k -Value $entries[$k] }
  Set-ItemProperty -Path $key -Name NoModify -Value 1 -Type DWord
  Set-ItemProperty -Path $key -Name NoRepair -Value 1 -Type DWord

  $text = "დაინსტალირდა!`n`nხატულა დაემატა სამუშაო მაგიდაზე: $appName.`nმონაცემები ინახება აქ:`n$dataDir"
  if ($migrated) { $text += "`n`nარსებული მონაცემები გადმოტანილია პროექტის საქაღალდიდან." }
  Say $text
  if (-not $NoLaunch) { Start-Process (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $InstallDir 'CarParts.ps1')`"" }
} catch {
  Say "Installation failed:`n`n$($_.Exception.Message)" 'Error'
  exit 1
}
