#!/bin/bash
# Build the React wallet (ui/) for https://xln.finance/ui/ without touching the
# checkout the pm2 services run from. Runs ON the server:
#   ssh root@xln.finance 'bash -s' < scripts/deployment/deploy-ui.sh
# A separate worktree builds the Runtime checkout's exact revision by default;
# XLN_UI_DEPLOY_SHA may select another reviewed main commit explicitly.
# nginx aliases /ui/ to its ui/dist.
set -euo pipefail

MAIN_REPO="${XLN_MAIN_REPO:-/root/xln}"
UI_TREE="${XLN_UI_TREE:-/root/xln-ui}"
BUN="${BUN:-/root/.bun/bin/bun}"
DEPLOY_SHA="${XLN_UI_DEPLOY_SHA:-$(git -C "$MAIN_REPO" rev-parse HEAD)}"
if [[ ! "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "UI_DEPLOY_EXACT_SHA_REQUIRED:$DEPLOY_SHA" >&2
  exit 1
fi

git -C "$MAIN_REPO" fetch -q origin main
git -C "$MAIN_REPO" cat-file -e "$DEPLOY_SHA^{commit}"
git -C "$MAIN_REPO" merge-base --is-ancestor "$DEPLOY_SHA" origin/main
if [ ! -d "$UI_TREE" ]; then
  git -C "$MAIN_REPO" worktree add --detach "$UI_TREE" "$DEPLOY_SHA"
else
  # Checkout may carry modified or untracked source into a different commit.
  # Refuse both before building a wallet that would claim the reviewed SHA.
  git -C "$UI_TREE" diff --exit-code --quiet
  git -C "$UI_TREE" diff --cached --exit-code --quiet
  untracked_sources="$(git -C "$UI_TREE" ls-files --others --exclude-standard)"
  if [ -n "$untracked_sources" ]; then
    echo "UI_DEPLOY_UNTRACKED_SOURCE" >&2
    exit 1
  fi
  git -C "$UI_TREE" checkout -q --detach "$DEPLOY_SHA"
fi
test "$(git -C "$UI_TREE" rev-parse HEAD)" = "$DEPLOY_SHA"
echo "ui tree at $DEPLOY_SHA"

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
        try_files \$uri /ui/index.html;
        add_header Content-Security-Policy "frame-ancestors 'self'" always;
        location ~* /ui/assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
        location ~* /ui/(runtime|account-worker)\.js$ { add_header Cache-Control "no-store, must-revalidate"; }
    }
then: nginx -t && systemctl reload nginx
NGINX
