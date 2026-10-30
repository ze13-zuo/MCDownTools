@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org/
  pause
  exit /b 1
)

if not defined PORT set "PORT=11459"
if not defined HOST set "HOST=127.0.0.1"

echo 正在启动 MCDownTools...
echo 访问地址：http://%HOST%:%PORT%
echo 按 Ctrl+C 停止服务。
echo.

node src\index.js
if errorlevel 1 pause
