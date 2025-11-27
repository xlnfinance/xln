#!/bin/bash
# setup xln news cron jobs on server
# run as: bash scripts/setup-news-cron.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
XLN_DIR="$(dirname "$SCRIPT_DIR")"

echo "⚡ xln news cron setup"
echo "   script dir: $SCRIPT_DIR"
echo "   xln dir: $XLN_DIR"

# ensure data directories exist
mkdir -p "$XLN_DIR/data/news-cache"
mkdir -p "$XLN_DIR/frontend/static/news/data"

# create wrapper scripts for cron
cat > "$SCRIPT_DIR/run-hourly.sh" << 'EOF'
#!/bin/bash
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"
bun scripts/news-cron.ts hourly >> /var/log/xln-news-hourly.log 2>&1
EOF

cat > "$SCRIPT_DIR/run-6hourly.sh" << 'EOF'
#!/bin/bash
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"
bun scripts/news-cron.ts 6hourly >> /var/log/xln-news-6hourly.log 2>&1
EOF

chmod +x "$SCRIPT_DIR/run-hourly.sh"
chmod +x "$SCRIPT_DIR/run-6hourly.sh"

echo "✓ created wrapper scripts"

# setup cron jobs
CRON_HOURLY="0 * * * * $SCRIPT_DIR/run-hourly.sh"
CRON_6HOURLY="0 */6 * * * $SCRIPT_DIR/run-6hourly.sh"

# add to crontab if not already there
(crontab -l 2>/dev/null | grep -v "xln-news" || true; echo "# xln-news cron jobs"; echo "$CRON_HOURLY"; echo "$CRON_6HOURLY") | crontab -

echo "✓ cron jobs installed:"
echo "   hourly: summaries for 200+ pt stories"
echo "   every 6h: comment digests"
echo ""
echo "📋 current crontab:"
crontab -l | grep -A2 "xln-news" || echo "(none found)"
echo ""
echo "📝 logs at:"
echo "   /var/log/xln-news-hourly.log"
echo "   /var/log/xln-news-6hourly.log"
echo ""
echo "🧪 test run:"
echo "   bun scripts/news-cron.ts hourly"
echo "   bun scripts/news-cron.ts 6hourly"
