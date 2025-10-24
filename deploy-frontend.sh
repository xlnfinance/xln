#!/bin/bash
set -e

echo "🚀 Deploying xln frontend to production..."

# Add SSH key to agent if not already added
if ! ssh-add -l | grep -q "xln_deploy"; then
  echo "📝 Adding SSH key to agent..."
  ssh-add ~/.ssh/xln_deploy
fi

echo "📡 Connecting to xln.finance server..."
ssh root@xln.finance << 'ENDSSH'
  set -e

  echo "📦 Pulling latest code..."
  cd /root/xln
  git stash || true
  git pull

  echo "🔨 Building frontend..."
  cd frontend
  /root/.bun/bin/bun install
  /root/.bun/bin/bun run build

  echo "📂 Copying to nginx..."
  cp -r build/* /var/www/html/

  echo "🔄 Reloading nginx..."
  systemctl reload nginx

  echo "✅ Deployment complete!"
ENDSSH

echo ""
echo "🎉 Frontend successfully deployed to https://xln.finance"
echo "   Clear localStorage or use incognito mode to see landing page"
