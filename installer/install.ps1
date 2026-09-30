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

# Shortcuts are created through the Windows shell-link interface with Unicode strings. The usual
# WScript.Shell component converts to the local ANSI code page, which turns Georgian file names
# into '?????' (and fails) on any PC whose Windows language is not Georgian/UTF-8.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CpShortcut
{
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, int fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
        void Resolve(IntPtr hwnd, int fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010B-0000-0000-C000-000000000046")]
    private interface IPersistFile
    {
        void GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, int dwMode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
    }

    public static void Create(string path, string target, string arguments, string workDir, string icon, string description)
    {
        IShellLinkW link = (IShellLinkW)new ShellLink();
        link.SetPath(target);
        link.SetArguments(arguments);
        link.SetWorkingDirectory(workDir);
        link.SetIconLocation(icon, 0);
        link.SetShowCmd(7);
        link.SetDescription(description);
        ((IPersistFile)link).Save(path, true);
    }
}
'@

# $folder\<Georgian name>.lnk; if that ever fails, fall back to the plain ASCII name so the install still works
function New-Shortcut([string]$folder, [string]$icon) {
  $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $InstallDir 'CarParts.ps1')`""
  foreach ($name in "$appName.lnk", 'CarParts.lnk') {
    try {
      [CpShortcut]::Create((Join-Path $folder $name), $powershell, $arguments, $InstallDir, $icon, $appName)
      return
    } catch {
      Write-Host "shortcut '$name' failed: $($_.Exception.Message)"
    }
  }
  throw "Could not create a shortcut in $folder"
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
  New-Shortcut $DesktopDir $icon
  New-Shortcut $StartMenuDir $icon

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
