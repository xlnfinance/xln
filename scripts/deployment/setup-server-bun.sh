#!/bin/bash

# XLN Server Setup Script - Pure Bun Approach
# No PM2, just Bun + systemd for production

set -e

echo "🚀 XLN Server Setup (Pure Bun)"
echo "=============================="

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    log_error "Please run as root (use sudo)"
    exit 1
fi

ACTUAL_USER="${SUDO_USER:-$(whoami)}"
USER_HOME=$(eval echo ~$ACTUAL_USER)

# 1. System Update
log_info "1️⃣  Updating system..."
apt-get update -qq && apt-get upgrade -y
log_success "System updated"

# 2. Install essentials (no Node.js needed!)
log_info "2️⃣  Installing essential packages..."
apt-get install -y curl wget git htop unzip build-essential nginx
log_success "Essential packages installed"

# 3. Install Bun (only thing we need!)
log_info "3️⃣  Installing Bun..."
if ! sudo -u $ACTUAL_USER bash -c 'command -v bun >/dev/null 2>&1'; then
    sudo -u $ACTUAL_USER bash -c 'curl -fsSL https://bun.sh/install | bash'
    
    # Add bun to PATH
    BUN_PATH="$USER_HOME/.bun/bin"
    echo "export PATH=\"$BUN_PATH:\$PATH\"" >> "$USER_HOME/.bashrc"
    chown $ACTUAL_USER:$ACTUAL_USER "$USER_HOME/.bashrc"
    
    log_success "Bun installed"
else
    log_success "Bun already installed"
fi

# 4. Create XLN directory
log_info "4️⃣  Setting up XLN directory..."
XLN_DIR="$USER_HOME/xln"
sudo -u $ACTUAL_USER mkdir -p "$XLN_DIR/logs"
log_success "XLN directory ready"

# 5. Configure Nginx (same as before)
log_info "5️⃣  Configuring Nginx..."
cat > /etc/nginx/sites-available/xln << EOF
server {
    listen 80;
    server_name _;
    
    location / {
        root $USER_HOME/xln/frontend/build;
        try_files \$uri \$uri/ /index.html;
        
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
    }
    
    location /api/ {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
    
    location /ws {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
    }

}

server {
    listen 8090 ssl http2;
    server_name xln.finance;
    ssl_certificate /etc/letsencrypt/live/xln.finance/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xln.finance/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:18090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400;
    }
}

server {
    listen 8091 ssl http2;
    server_name xln.finance;
    ssl_certificate /etc/letsencrypt/live/xln.finance/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xln.finance/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:18091;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400;
    }
}

server {
    listen 8092 ssl http2;
    server_name xln.finance;
    ssl_certificate /etc/letsencrypt/live/xln.finance/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xln.finance/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:18092;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400;
    }
}

server {
    listen 8093 ssl http2;
    server_name xln.finance;
    ssl_certificate /etc/letsencrypt/live/xln.finance/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xln.finance/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:18093;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400;
    }
}
EOF

ln -sf /etc/nginx/sites-available/xln /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
systemctl restart nginx
log_success "Nginx configured"

# 6. Create systemd service for XLN (instead of PM2)
log_info "6️⃣  Creating systemd service..."
cat > /etc/systemd/system/xln.service << EOF
[Unit]
Description=XLN Consensus Debugger
After=network.target

[Service]
Type=simple
User=$ACTUAL_USER
WorkingDirectory=$XLN_DIR
Environment=PATH=$USER_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production
Environment=PORT=8080
ExecStart=$USER_HOME/.bun/bin/bun run dev
Restart=always
RestartSec=10
StandardOutput=append:$XLN_DIR/logs/xln.log
StandardError=append:$XLN_DIR/logs/xln-error.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable xln
log_success "Systemd service created"

# 7. Create deployment script
log_info "7️⃣  Creating deployment script..."
sudo -u $ACTUAL_USER cat > "$XLN_DIR/deploy.sh" << 'EOF'
#!/bin/bash
# XLN Deployment Script - Lessons learned from Vultr deployment
set -e

echo "🚀 Deploying XLN (Pure Bun)..."
cd "$(dirname "$0")"

# Pull changes if git repo
if [ -d ".git" ]; then
    echo "📥 Pulling latest changes..."
    git pull origin main
fi

# Install deps with Bun
echo "📦 Installing dependencies..."
export PATH="$HOME/.bun/bin:$PATH"
bun install

# CRITICAL: Build server.js with bundled dependencies for browser
echo "🔧 Building server.js with bundled dependencies..."
mkdir -p frontend/static dist
bun build src/server.ts --target=browser --outdir=dist --minify --external http --external https --external zlib --external fs --external path --external crypto --external stream --external buffer --external url --external net --external tls --external os --external util
cp dist/server.js frontend/static/server.js

# Build frontend with Bun
echo "🏗️  Building frontend..."
cd frontend
bun install
bun run build
cd ..

# CRITICAL: Copy bundled server.js to build directory
echo "📋 Copying bundled server.js to build directory..."
cp frontend/static/server.js frontend/build/server.js

# Kill any existing background processes
echo "🛑 Stopping existing server processes..."
pkill -f "bun run serve" || true

# Start server in background (don't use systemd - it was problematic)
echo "🚀 Starting XLN server in background..."
mkdir -p logs
nohup bun run serve.ts > logs/xln.log 2>&1 &

# Wait for server to start
sleep 3

# Test if server is responding
if curl -s http://localhost:8080/healthz > /dev/null; then
    echo "✅ Server is responding!"
else
    echo "⚠️  Server might still be starting, checking logs..."
    tail -5 logs/xln.log
fi

echo "✅ Deployment complete!"
echo "🌐 XLN running at: http://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP')"
echo "📊 Check status: tail -f logs/xln.log"
echo "📊 Check processes: ps aux | grep bun"
EOF

chmod +x "$XLN_DIR/deploy.sh"
chown $ACTUAL_USER:$ACTUAL_USER "$XLN_DIR/deploy.sh"
log_success "Deployment script created"

# 8. Configure firewall
log_info "8️⃣  Configuring firewall..."
apt-get install -y ufw
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow ssh >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
log_success "Firewall configured"

echo ""
echo "🎉 Pure Bun Setup Complete!"
echo "=========================="
log_success "No PM2, no Node.js - just Bun! 🚀"
echo ""
echo "📋 Next steps:"
echo "   1. Clone XLN to $XLN_DIR"
echo "   2. Run: cd $XLN_DIR && ./deploy.sh"
echo "   3. Access at: http://YOUR_SERVER_IP"
echo ""
echo "🔧 Service management:"
echo "   • Start: sudo systemctl start xln"
echo "   • Stop: sudo systemctl stop xln"
echo "   • Status: sudo systemctl status xln"
echo "   • Logs: journalctl -u xln -f"
echo "   • Restart: sudo systemctl restart xln"
echo ""
log_success "Ready for pure Bun deployment! ⚡"
