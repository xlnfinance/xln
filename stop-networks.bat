@echo off
echo 🛑 Stopping XLN Demo Networks...

REM Kill all hardhat node processes
taskkill /f /im node.exe 2>nul

echo ✅ All networks stopped!
echo 💡 Use 'start-networks.bat' to restart networks
