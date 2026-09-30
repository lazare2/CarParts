# Removes the CarParts program, its shortcuts and its "Installed apps" entry.
# Your data (%APPDATA%\CarParts) is NOT deleted.
param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$appName = 'ავტონაწილები'
$installDir = $PSScriptRoot
$desktopDir = if ($env:CARPARTS_DESKTOP_DIR) { $env:CARPARTS_DESKTOP_DIR } else { [Environment]::GetFolderPath('Desktop') }
$startMenuDir = if ($env:CARPARTS_STARTMENU_DIR) { $env:CARPARTS_STARTMENU_DIR } else { Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' }
$dataBase = if ($env:CARPARTS_HOME) { $env:CARPARTS_HOME } else { Join-Path $env:APPDATA 'CarParts' }

if (-not $Quiet) {
  $answer = [System.Windows.Forms.MessageBox]::Show("წავშალო პროგრამა $appName?`n`nთქვენი მონაცემები არ წაიშლება:`n$dataBase", $appName, 'YesNo', 'Question')
  if ($answer -ne 'Yes') { exit 0 }
}

Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -eq (Join-Path $installDir 'node.exe') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

foreach ($folder in $desktopDir, $startMenuDir) {
  foreach ($name in "$appName.lnk", 'CarParts.lnk') { Remove-Item -LiteralPath (Join-Path $folder $name) -Force -ErrorAction SilentlyContinue }
}
Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CarParts' -Recurse -Force -ErrorAction SilentlyContinue

# this script lives inside the folder, so delete the folder a moment after we exit
Start-Process cmd.exe -WindowStyle Hidden -ArgumentList "/c ping 127.0.0.1 -n 3 >nul & rmdir /s /q `"$installDir`""
if ($Quiet) { Write-Host 'uninstalled' }
else { [System.Windows.Forms.MessageBox]::Show("პროგრამა წაიშალა. მონაცემები დარჩა აქ:`n$dataBase", $appName, 'OK', 'Information') | Out-Null }
