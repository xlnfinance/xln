#!/bin/bash
# One-liner installer for XLN
set -e

echo "🚀 Installing XLN..."
echo ""

# Clone repo to xln directory
if [ -d "xln" ]; then
    echo "⚠️  Directory 'xln' already exists"
    read -p "Delete and reinstall? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -rf xln
    else
        echo "❌ Installation cancelled"
        exit 1
    fi
fi

git clone https://github.com/xlnfinance/xln.git xln
cd xln

echo ""
echo "✅ Cloned to ./xln"
echo "🚀 Starting development environment..."
echo ""

# Run dev (which auto-installs everything)
./dev-full.sh
