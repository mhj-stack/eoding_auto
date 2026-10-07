@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || goto missing
node scripts\plugin-start.mjs --setup-only
if errorlevel 1 goto failed
node scripts\configure-plugin.mjs
if errorlevel 1 goto failed
echo Setup complete. Read README for connecting your AI.
pause
exit /b 0
:missing
echo Install Node.js 22+ and Python 3.10+ first.
:failed
echo Setup failed. Review the error above and retry.
pause
exit /b 1
