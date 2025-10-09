#!/bin/bash

# XLN Server Setup Script
# Handles fresh installs and updates intelligently
# Usage: ./setup-server.sh

set -e

echo "🚀 XLN Server Setup Script"
echo "=========================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    log_error "Please run as root (use sudo)"
    exit 1
fi

# Get the actual user (in case of sudo)
ACTUAL_USER="${SUDO_USER:-$(whoami)}"
USER_HOME=$(eval echo ~$ACTUAL_USER)

log_info "Setting up for user: $ACTUAL_USER"
log_info "User home: $USER_HOME"

# 1. System Update
log_info "1️⃣  Checking system updates..."
if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    log_success "System packages updated"
else
    log_error "This script requires Ubuntu/Debian with apt-get"
    exit 1
fi

# 2. Install essential packages
log_info "2️⃣  Installing essential packages..."
PACKAGES="curl wget git htop unzip build-essential"
MISSING_PACKAGES=""

for pkg in $PACKAGES; do
    if ! dpkg -l | grep -q "^ii  $pkg "; then
        MISSING_PACKAGES="$MISSING_PACKAGES $pkg"
    fi
done

if [ -n "$MISSING_PACKAGES" ]; then
    log_info "Installing missing packages:$MISSING_PACKAGES"
    apt-get install -y $MISSING_PACKAGES
    log_success "Essential packages installed"
else
    log_success "All essential packages already installed"
fi

# 3. Install/Update Node.js 20
log_info "3️⃣  Checking Node.js installation..."
NODE_VERSION_REQUIRED="20"

if command -v node >/dev/null 2>&1; then
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -ge "$NODE_VERSION_REQUIRED" ]; then
        log_success "Node.js $NODE_VERSION is already installed (>= $NODE_VERSION_REQUIRED)"
    else
        log_warning "Node.js $NODE_VERSION found, upgrading to v20..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
        log_success "Node.js upgraded to $(node -v)"
    fi
else
    log_info "Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    log_success "Node.js $(node -v) installed"
fi

# 4. Install/Update Bun
log_info "4️⃣  Checking Bun installation..."
if sudo -u $ACTUAL_USER bash -c 'command -v bun >/dev/null 2>&1'; then
    BUN_VERSION=$(sudo -u $ACTUAL_USER bun --version)
    log_success "Bun $BUN_VERSION is already installed"
else
    log_info "Installing Bun..."
    sudo -u $ACTUAL_USER bash -c 'curl -fsSL https://bun.sh/install | bash'
    
    # Add bun to PATH for current session and future sessions
    BUN_PATH="$USER_HOME/.bun/bin"
    if ! grep -q "$BUN_PATH" "$USER_HOME/.bashrc"; then
        echo "export PATH=\"$BUN_PATH:\$PATH\"" >> "$USER_HOME/.bashrc"
    fi
    
    # Make sure .bashrc is owned by the actual user
    chown $ACTUAL_USER:$ACTUAL_USER "$USER_HOME/.bashrc"
    
    log_success "Bun installed successfully"
fi

# 5. Install/Update PM2
log_info "5️⃣  Checking PM2 installation..."
if command -v pm2 >/dev/null 2>&1; then
    PM2_VERSION=$(pm2 --version)
    log_success "PM2 $PM2_VERSION is already installed"
else
    log_info "Installing PM2..."
    npm install -g pm2
    log_success "PM2 installed successfully"
fi

# 6. Install/Configure Nginx
log_info "6️⃣  Checking Nginx installation..."
if systemctl is-active --quiet nginx; then
    log_success "Nginx is already installed and running"
else
    if ! command -v nginx >/dev/null 2>&1; then
        log_info "Installing Nginx..."
        apt-get install -y nginx
    fi
    
    log_info "Starting and enabling Nginx..."
    systemctl start nginx
    systemctl enable nginx
    log_success "Nginx installed and configured"
fi

# 7. Configure Firewall (UFW)
log_info "7️⃣  Configuring firewall..."
if command -v ufw >/dev/null 2>&1; then
    # Install ufw if not present
    if ! dpkg -l | grep -q "^ii  ufw "; then
        apt-get install -y ufw
    fi
    
    # Configure firewall rules
    ufw --force reset >/dev/null 2>&1
    ufw default deny incoming >/dev/null 2>&1
    ufw default allow outgoing >/dev/null 2>&1
    ufw allow ssh >/dev/null 2>&1
    ufw allow 80/tcp >/dev/null 2>&1
    ufw allow 443/tcp >/dev/null 2>&1
    ufw allow 8080/tcp >/dev/null 2>&1  # For development
    ufw --force enable >/dev/null 2>&1
    log_success "Firewall configured (SSH, HTTP, HTTPS, 8080)"
else
    log_warning "UFW not available, skipping firewall configuration"
fi

# 8. Create XLN directory and set permissions
log_info "8️⃣  Setting up XLN directory..."
XLN_DIR="$USER_HOME/xln"

if [ ! -d "$XLN_DIR" ]; then
    log_info "Creating XLN directory at $XLN_DIR"
    sudo -u $ACTUAL_USER mkdir -p "$XLN_DIR"
fi

# Create necessary subdirectories
sudo -u $ACTUAL_USER mkdir -p "$XLN_DIR/logs"
sudo -u $ACTUAL_USER mkdir -p "$XLN_DIR/pids"

log_success "XLN directory structure ready"

# 9. Configure Nginx for XLN
log_info "9️⃣  Configuring Nginx for XLN..."
NGINX_CONFIG="/etc/nginx/sites-available/xln"

cat > "$NGINX_CONFIG" << 'EOF'
server {
    listen 80;
    server_name _;
    
    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header X-Content-Type-Options "nosniff" always;
    
    # Serve static frontend files
    location / {
        root /home/ubuntu/xln/frontend/build;
        try_files $uri $uri/ /index.html;
        
        # Cache static assets
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
    }
    
    # Proxy API requests to backend
    location /api/ {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }
    
    # WebSocket support
    location /ws {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
    
    # Health check endpoint
    location /health {
        access_log off;
        return 200 "healthy\n";
        add_header Content-Type text/plain;
    }
}
EOF

# Update the root path to use the actual user's home
sed -i "s|/home/ubuntu|$USER_HOME|g" "$NGINX_CONFIG"

# Enable the site
ln -sf /etc/nginx/sites-available/xln /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Test nginx configuration
if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx
    log_success "Nginx configured and reloaded"
else
    log_error "Nginx configuration test failed"
    exit 1
fi

# 10. Create PM2 ecosystem file
log_info "🔟 Creating PM2 configuration..."
ECOSYSTEM_FILE="$XLN_DIR/ecosystem.production.cjs"

sudo -u $ACTUAL_USER cat > "$ECOSYSTEM_FILE" << EOF
module.exports = {
  apps: [{
    name: 'xln-server',
    script: 'bun',
    args: 'run dev',
    cwd: '$XLN_DIR',
    env: {
      NODE_ENV: 'production',
      PORT: 8080
    },
    watch: false,
    max_memory_restart: '2G',
    error_file: 'logs/err.log',
    out_file: 'logs/out.log',
    log_file: 'logs/combined.log',
    time: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s'
  }]
}
EOF

log_success "PM2 ecosystem file created"

# 11. Setup PM2 startup script
log_info "1️⃣1️⃣ Configuring PM2 startup..."
if sudo -u $ACTUAL_USER pm2 ping >/dev/null 2>&1; then
    # PM2 is running, save current processes and setup startup
    sudo -u $ACTUAL_USER pm2 save >/dev/null 2>&1
    sudo -u $ACTUAL_USER pm2 startup >/dev/null 2>&1 || true
    log_success "PM2 startup configured"
else
    log_success "PM2 startup will be configured when first process starts"
fi

# 12. Create deployment script
log_info "1️⃣2️⃣ Creating deployment script..."
DEPLOY_SCRIPT="$XLN_DIR/deploy.sh"

sudo -u $ACTUAL_USER cat > "$DEPLOY_SCRIPT" << 'EOF'
#!/bin/bash

# XLN Deployment Script
set -e

echo "🚀 Deploying XLN..."

# Navigate to XLN directory
cd "$(dirname "$0")"

# Pull latest changes if git repo exists
if [ -d ".git" ]; then
    echo "📥 Pulling latest changes..."
    git pull origin main
else
    echo "⚠️  Not a git repository, skipping git pull"
fi

# Install/update dependencies
echo "📦 Installing dependencies..."
export PATH="$HOME/.bun/bin:$PATH"
bun install

# Build frontend
echo "🏗️  Building frontend..."
cd frontend
bun install
bun run build
cd ..

# Restart PM2 process
echo "🔄 Restarting server..."
pm2 restart ecosystem.production.cjs || pm2 start ecosystem.production.cjs
pm2 save

echo "✅ Deployment complete!"
echo "🌐 XLN is running at: http://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP')"
EOF

chmod +x "$DEPLOY_SCRIPT"
chown $ACTUAL_USER:$ACTUAL_USER "$DEPLOY_SCRIPT"

log_success "Deployment script created at $XLN_DIR/deploy.sh"

# 13. Final system check
log_info "1️⃣3️⃣ Running system check..."

# Check services
SERVICES_OK=true

if ! systemctl is-active --quiet nginx; then
    log_error "Nginx is not running"
    SERVICES_OK=false
else
    log_success "Nginx is running"
fi

if ! command -v node >/dev/null 2>&1; then
    log_error "Node.js is not available"
    SERVICES_OK=false
else
    log_success "Node.js $(node -v) is available"
fi

if ! sudo -u $ACTUAL_USER bash -c 'command -v bun >/dev/null 2>&1'; then
    log_error "Bun is not available for user $ACTUAL_USER"
    SERVICES_OK=false
else
    BUN_VERSION=$(sudo -u $ACTUAL_USER bash -c 'export PATH="$HOME/.bun/bin:$PATH"; bun --version')
    log_success "Bun $BUN_VERSION is available"
fi

if ! command -v pm2 >/dev/null 2>&1; then
    log_error "PM2 is not available"
    SERVICES_OK=false
else
    log_success "PM2 $(pm2 --version) is available"
fi

# Summary
echo ""
echo "🎉 XLN Server Setup Complete!"
echo "=============================="

if [ "$SERVICES_OK" = true ]; then
    log_success "All services are ready"
    echo ""
    echo "📋 Next steps:"
    echo "   1. Clone your XLN repository to $XLN_DIR"
    echo "   2. Run: cd $XLN_DIR && ./deploy.sh"
    echo "   3. Access XLN at: http://YOUR_SERVER_IP"
    echo ""
    echo "🔧 Useful commands:"
    echo "   • Deploy: $XLN_DIR/deploy.sh"
    echo "   • Check status: pm2 status"
    echo "   • View logs: pm2 logs xln-server"
    echo "   • Restart: pm2 restart xln-server"
    echo "   • Nginx status: systemctl status nginx"
else
    log_error "Some services failed to install properly"
    echo "Please check the errors above and run the script again"
    exit 1
fi

echo ""
log_success "Server is ready for XLN deployment! 🚀"
