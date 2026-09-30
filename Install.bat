@echo off
rem Installs the app for the current user: desktop icon + start menu entry. Your data is kept safe.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "installer\install.ps1"
