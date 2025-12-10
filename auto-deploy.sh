#!/bin/bash
# Auto-deploy script - run after every git push
# IMPORTANT: Run `npm run test:landing` locally BEFORE pushing

set -e  # Exit on any error

ssh -i ~/.ssh/xln_deploy root@xln.finance << 'ENDSSH'
cd /root/xln
git pull origin main

# Add bun to PATH
export PATH="$HOME/.bun/bin:$PATH"

# CRITICAL: Build runtime.js FIRST (for browser)
echo "🔧 Building runtime.js..."
bun build runtime/runtime.ts --target=browser --outfile=frontend/static/runtime.js --minify \
  --external http --external https --external zlib \
  --external fs --external path --external crypto \
  --external stream --external buffer --external url \
  --external net --external tls --external os --external util

# Then build frontend
cd frontend
npm run build
cp -r build/* /var/www/html/
echo "✅ Deployed at $(date)"
ENDSSH
