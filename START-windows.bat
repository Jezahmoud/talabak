@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install the LTS version, then run this file again. & start https://nodejs.org & pause & exit /b)
if not exist node_modules call npm install
call npm start
pause
