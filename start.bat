@echo off
title DJ Stream Launcher
color 0A

echo.
echo  ==========================================
echo   DJ STREAM SERVER LAUNCHER
echo  ==========================================
echo.

:: Kill any existing node processes
taskkill /F /IM node.exe /T >nul 2>&1
timeout /t 1 /nobreak >nul

:: Start Node server in a new window
echo  Starting server...
start "DJ Stream Server" cmd /k "cd /d %~dp0 && node server.js"
timeout /t 2 /nobreak >nul

:: Check for cloudflared
if exist "%~dp0cloudflared.exe" (
    echo  Starting Cloudflare Tunnel...
    start "Cloudflare Tunnel" cmd /k "cd /d %~dp0 && cloudflared.exe tunnel --url http://localhost:3000"
    echo.
    echo  Tunnel is starting...
    echo  Check the "Cloudflare Tunnel" window for your public HTTPS URL.
    echo  Share that URL with your clients.
) else (
    echo.
    echo  ==========================================
    echo   ONLINE ACCESS - Setup Required
    echo  ==========================================
    echo.
    echo  To give clients online access, download cloudflared:
    echo.
    echo  1. Go to:
    echo     https://github.com/cloudflare/cloudflared/releases/latest
    echo.
    echo  2. Download: cloudflared-windows-amd64.exe
    echo.
    echo  3. Rename it to: cloudflared.exe
    echo.
    echo  4. Place it in: %~dp0
    echo.
    echo  5. Run start.bat again
    echo.
    echo  (Server is still running locally at http://localhost:3000)
    echo  ==========================================
)

echo.
echo  Local URLs:
echo    Viewers : http://localhost:3000
echo    DJ Panel: http://localhost:3000/dj.html?key=%ADMIN_KEY%
echo    Admin   : http://localhost:3000/admin-login.html
echo.
pause
