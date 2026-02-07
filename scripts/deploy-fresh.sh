#!/bin/bash
# Deploy server to production with fresh DB state (skips frontend build)
# Usage: ./scripts/deploy-fresh.sh

set -e

echo "=== Pushing to remote ==="
git push

echo "=== Deploying server (skip frontend) ==="
ssh root@xln.finance 'cd /root/xln && export PATH="$HOME/.bun/bin:$PATH" && git pull origin main && bun install && bun build runtime/runtime.ts --target=browser --external http --external https --external zlib --external fs --external path --external crypto --external stream --external buffer --external url --external net --external tls --external os --external util --outfile frontend/static/runtime.js && pm2 stop xln-server && rm -rf db-tmp/* && pm2 start xln-server'

echo "=== Waiting for server ==="
sleep 5
ssh root@xln.finance "curl -s http://localhost:8080/api/health | head -1"

echo ""
echo "✅ Deployed fresh. Ready for testing."
