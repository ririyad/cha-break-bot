@echo off
title Cha-Break Bot Live (public link)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed. Install the LTS version from https://nodejs.org
  pause
  exit /b 1
)
where cloudflared >nul 2>nul
if errorlevel 1 (
  echo.
  echo   cloudflared is not installed. Open PowerShell and run:
  echo     winget install --id Cloudflare.cloudflared
  echo   then close PowerShell and double-click this file again.
  echo.
  pause
  exit /b 1
)
node server.js --tunnel
echo.
pause
