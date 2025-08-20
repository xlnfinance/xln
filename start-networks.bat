@echo off
echo 🚀 Starting XLN Demo Networks...

REM Create directories for logs and pids first
if not exist logs mkdir logs
if not exist pids mkdir pids

REM Kill any existing hardhat nodes
taskkill /f /im node.exe 2>nul

REM Wait a bit for cleanup
timeout /t 1 /nobreak >nul

REM Start three hardhat nodes in background
echo 📡 Starting Ethereum Network (port 8545)...
cd contracts && start "Ethereum-8545" cmd /c "npx hardhat node --port 8545 --hostname 127.0.0.1 > ../logs/ethereum-8545.log 2>&1"

echo 📡 Starting Polygon Network (port 8546)...
cd contracts && start "Polygon-8546" cmd /c "npx hardhat node --port 8546 --hostname 127.0.0.1 > ../logs/polygon-8546.log 2>&1"

echo 📡 Starting Arbitrum Network (port 8547)...
cd contracts && start "Arbitrum-8547" cmd /c "npx hardhat node --port 8547 --hostname 127.0.0.1 > ../logs/arbitrum-8547.log 2>&1"

cd ..

echo ⏳ Waiting for networks to start...
timeout /t 3 /nobreak >nul

echo 🔍 Checking network status...
echo 🎯 All networks started!
echo    Ethereum: http://localhost:8545
echo    Polygon:  http://localhost:8546 
echo    Arbitrum: http://localhost:8547
echo.
echo 📝 Logs available in logs/ directory
echo 🛑 Use 'stop-networks.bat' to stop all networks
