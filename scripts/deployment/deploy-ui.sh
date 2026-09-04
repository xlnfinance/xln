#!/bin/bash
# Build the React wallet (ui/) for https://xln.finance/ui/ without touching the
# checkout the pm2 services run from. Runs ON the server:
#   ssh root@xln.finance 'bash -s' < scripts/deployment/deploy-ui.sh
# A separate worktree tracks origin/main; nginx aliases /ui/ to its ui/dist.
set -euo pipefail

MAIN_REPO="${XLN_MAIN_REPO:-/root/xln}"
UI_TREE="${XLN_UI_TREE:-/root/xln-ui}"
BUN="${BUN:-/root/.bun/bin/bun}"

git -C "$MAIN_REPO" fetch -q origin main
if [ ! -d "$UI_TREE" ]; then
  git -C "$MAIN_REPO" worktree add --detach "$UI_TREE" origin/main
else
  git -C "$UI_TREE" checkout -q --detach origin/main
fi
echo "ui tree at $(git -C "$UI_TREE" rev-parse --short HEAD)"

cd "$UI_TREE"
"$BUN" install --frozen-lockfile
cd ui
"$BUN" install --frozen-lockfile
"$BUN" run build:hosted
test -f dist/index.html && test -f dist/runtime.js && test -f dist/account-worker.js
echo "built $UI_TREE/ui/dist"
cat <<NGINX
nginx (once, inside the 443 server block, before "location /"):
    location = /ui { return 301 /ui/; }
    location ^~ /ui/ {
        alias $UI_TREE/ui/dist/;
        try_files \$uri \$uri/ /ui/index.html;
        add_header Content-Security-Policy "frame-ancestors 'self'" always;
        location ~* /ui/assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
        location ~* /ui/(runtime|account-worker)\.js$ { add_header Cache-Control "no-store, must-revalidate"; }
    }
then: nginx -t && systemctl reload nginx
NGINX
