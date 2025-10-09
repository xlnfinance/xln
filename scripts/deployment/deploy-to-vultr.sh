#!/bin/bash

# Deploy XLN to Vultr Server
# Usage: ./deploy-to-vultr.sh [SERVER_IP]

set -e

# Configuration
SERVER_IP="${1:-136.244.85.89}"
SERVER_USER="root"
XLN_DIR="/root/xln"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }

echo "🚀 Deploying XLN to Vultr Server"
echo "================================"
echo "Server: $SERVER_IP"
echo "User: $SERVER_USER"
echo ""

# Check if we can connect to server
log_info "Testing server connection..."
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes $SERVER_USER@$SERVER_IP exit 2>/dev/null; then
    echo "❌ Cannot connect to server $SERVER_IP"
    echo "Make sure:"
    echo "  1. Server is running"
    echo "  2. SSH key is configured"
    echo "  3. IP address is correct"
    exit 1
fi
log_success "Server connection OK"

# Check if setup script exists
if [ ! -f "setup-server.sh" ]; then
    echo "❌ setup-server.sh not found in current directory"
    exit 1
fi

# 1. Upload and run setup script
log_info "1️⃣  Running server setup..."
scp setup-server.sh $SERVER_USER@$SERVER_IP:/tmp/
ssh $SERVER_USER@$SERVER_IP "chmod +x /tmp/setup-server.sh && /tmp/setup-server.sh"
log_success "Server setup complete"

# 2. Check if XLN directory exists, if not clone it
log_info "2️⃣  Checking XLN repository..."
if ssh $SERVER_USER@$SERVER_IP "[ ! -d $XLN_DIR/.git ]"; then
    log_info "Cloning XLN repository..."
    ssh $SERVER_USER@$SERVER_IP "
        cd $(dirname $XLN_DIR) && 
        rm -rf $(basename $XLN_DIR) &&
        git clone https://github.com/xlnfinance/xln.git $(basename $XLN_DIR)
    "
    log_success "Repository cloned"
else
    log_success "Repository already exists"
fi

# 3. Deploy latest changes
log_info "3️⃣  Deploying latest changes..."

# Option A: Git-based deployment (recommended)
if git rev-parse --git-dir > /dev/null 2>&1; then
    log_info "Pushing latest changes to GitHub..."
    
    # Check if there are uncommitted changes
    if ! git diff-index --quiet HEAD --; then
        log_warning "You have uncommitted changes. Committing them..."
        git add .
        git commit -m "Auto-commit before deployment - $(date)"
    fi
    
    # Push to GitHub
    git push origin main
    
    # Pull on server and deploy
    ssh $SERVER_USER@$SERVER_IP "cd $XLN_DIR && ./deploy.sh"
    
    log_success "Git-based deployment complete"
else
    log_warning "Not a git repository, using direct file sync..."
    
    # Option B: Direct file sync
    log_info "Syncing files directly..."
    rsync -avz --delete \
        --exclude 'node_modules' \
        --exclude '.git' \
        --exclude 'dist' \
        --exclude 'logs' \
        --exclude 'pids' \
        --exclude '.env*' \
        . $SERVER_USER@$SERVER_IP:$XLN_DIR/
    
    # Run deployment on server
    ssh $SERVER_USER@$SERVER_IP "cd $XLN_DIR && ./deploy.sh"
    
    log_success "Direct sync deployment complete"
fi

# 4. Check deployment status
log_info "4️⃣  Checking deployment status..."
DEPLOYMENT_STATUS=$(ssh $SERVER_USER@$SERVER_IP "cd $XLN_DIR && pm2 status --no-color | grep xln-server || echo 'not running'")

if echo "$DEPLOYMENT_STATUS" | grep -q "online"; then
    log_success "XLN server is running"
else
    log_warning "XLN server status unclear, checking logs..."
    ssh $SERVER_USER@$SERVER_IP "cd $XLN_DIR && pm2 logs xln-server --lines 10 --no-color || echo 'No logs available'"
fi

# 5. Final summary
echo ""
echo "🎉 Deployment Summary"
echo "===================="
log_success "XLN deployed to: http://$SERVER_IP"
echo ""
echo "🔧 Useful commands:"
echo "   • Check status: ssh $SERVER_USER@$SERVER_IP 'pm2 status'"
echo "   • View logs: ssh $SERVER_USER@$SERVER_IP 'pm2 logs xln-server'"
echo "   • Restart: ssh $SERVER_USER@$SERVER_IP 'pm2 restart xln-server'"
echo "   • Redeploy: ./deploy-to-vultr.sh $SERVER_IP"
echo ""
log_success "Deployment complete! 🚀"
