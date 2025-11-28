#!/bin/bash
# XLN One-Liner Installer
# Usage: curl -fsSL https://xln.finance/install.sh | bash
set -e

echo "🚀 Installing XLN..."

# Check bun
if ! command -v bun &> /dev/null; then
    echo "📥 Installing bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
fi

# Clone
if [ -d "xln" ]; then
    echo "📁 xln/ exists, pulling latest..."
    cd xln && git pull
else
    git clone https://github.com/xlnfinance/xln.git
    cd xln
fi

# Run
echo "🚀 Starting XLN..."
bun run dev
