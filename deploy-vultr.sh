#!/bin/bash

# XLN Vultr Deployment Script
# Run this on a fresh Ubuntu 22.04 server

set -e

echo "🚀 Starting XLN deployment on Vultr..."

# Update system
echo "📦 Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install Node.js 18
echo "📦 Installing Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Bun
echo "📦 Installing Bun..."
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc

# Install Git and other tools
echo "📦 Installing Git and tools..."
sudo apt install -y git nginx pm2 htop curl

# Clone XLN repository
echo "📂 Cloning XLN repository..."
cd ~
if [ -d "xln" ]; then
    echo "Repository already exists, pulling latest..."
    cd xln
    git pull origin main
else
    git clone https://github.com/xlnfinance/xln.git
    cd xln
fi

# Install dependencies
echo "📦 Installing project dependencies..."
bun install

# Build frontend
echo "🏗️  Building frontend..."
cd frontend
bun install
bun run build
cd ..

# Create PM2 ecosystem file
echo "⚙️  Creating PM2 configuration..."
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'xln-server',
    script: 'bun',
    args: 'run dev',
    cwd: '/home/ubuntu/xln',
    env: {
      NODE_ENV: 'production',
      PORT: 8080
    },
    watch: false,
    max_memory_restart: '1G',
    error_file: 'logs/err.log',
    out_file: 'logs/out.log',
    log_file: 'logs/combined.log',
    time: true
  }]
}
EOF

# Create logs directory
mkdir -p logs

# Configure Nginx
echo "🌐 Configuring Nginx..."
sudo tee /etc/nginx/sites-available/xln << 'EOF'
server {
    listen 80;
    server_name _;
    
    # Serve static frontend files
    location / {
        root /home/ubuntu/xln/frontend/build;
        try_files $uri $uri/ /index.html;
        
        # Cache static assets
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
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
    }
    
    # WebSocket support for dev server
    location /ws {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
EOF

# Enable site and restart nginx
sudo ln -sf /etc/nginx/sites-available/xln /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx

# Start XLN with PM2
echo "🚀 Starting XLN with PM2..."
pm2 start ecosystem.config.js
pm2 save
pm2 startup

echo "✅ XLN deployment completed!"
echo ""
echo "🌐 Your XLN instance is now running at:"
echo "   http://$(curl -s ifconfig.me)"
echo ""
echo "📊 Useful commands:"
echo "   pm2 status          - Check process status"
echo "   pm2 logs xln-server - View logs"
echo "   pm2 restart all     - Restart application"
echo "   sudo systemctl status nginx - Check Nginx status"
echo ""
echo "🔧 Files locations:"
echo "   App: /home/ubuntu/xln"
echo "   Logs: /home/ubuntu/xln/logs"
echo "   Nginx config: /etc/nginx/sites-available/xln"
