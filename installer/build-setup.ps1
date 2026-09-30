# Builds dist\CarParts-Setup.exe: one file that installs the app on any Windows PC,
# even one without Node.js (node.exe is bundled). Uses IExpress, which is part of Windows.
#   powershell -ExecutionPolicy Bypass -File installer\build-setup.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $repo 'dist'
$work = Join-Path $env:TEMP 'carparts-build'
$target = Join-Path $dist 'CarParts-Setup.exe'
$ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
$stage = Join-Path $work 'app'
$pkg = Join-Path $work 'pkg'
New-Item -ItemType Directory -Force $stage, $pkg, $dist | Out-Null
Remove-Item $target -Force -ErrorAction SilentlyContinue

# 1. the ready-to-run app (including node.exe) as a zip
& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install.ps1') -StageTo $stage
if ($LASTEXITCODE -ne 0) { throw 'could not assemble the app files' }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath (Join-Path $pkg 'payload.zip') -CompressionLevel Optimal

# 2. what the self-extracting exe runs
Copy-Item (Join-Path $PSScriptRoot 'install.ps1') $pkg
Set-Content -Path (Join-Path $pkg 'setup.cmd') -Encoding ASCII -Value @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Payload "%~dp0payload.zip" > "%TEMP%\CarParts-setup.log" 2>&1
'@

# 3. IExpress recipe (note: it must run setup.cmd directly; a 'cmd /c ...' command line is silently ignored)
$sed = Join-Path $work 'setup.sed'
$sedText = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$target
FriendlyName=CarParts Setup
AppLaunched=setup.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=setup.cmd
UserQuietInstCmd=setup.cmd
FILE0="setup.cmd"
FILE1="install.ps1"
FILE2="payload.zip"
[SourceFiles]
SourceFiles0=$pkg\
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
"@
# IExpress wants Windows line endings
[IO.File]::WriteAllText($sed, ($sedText -replace "`r?`n", "`r`n"), [Text.Encoding]::ASCII)

# (IExpress cannot read a quoted path: give it a plain file name from its working folder)
Start-Process -FilePath (Join-Path $env:WINDIR 'System32\iexpress.exe') -ArgumentList '/N /Q setup.sed' -WorkingDirectory $work -Wait -WindowStyle Hidden
# IExpress can return before the file is completely written
for ($i = 0; $i -lt 60 -and -not (Test-Path $target); $i++) { Start-Sleep -Seconds 1 }
if (-not (Test-Path $target)) { throw 'IExpress did not produce the setup file' }
$size = -1
while ($size -ne (Get-Item $target).Length) { $size = (Get-Item $target).Length; Start-Sleep -Seconds 2 }

Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ('Built {0} ({1:N1} MB)' -f $target, ((Get-Item $target).Length / 1MB))
