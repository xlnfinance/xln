# XLN Vultr Deployment Guide

## 🚀 Quick Start

### 1. Create Vultr Server
- **OS:** Ubuntu 22.04 LTS
- **Plan:** Regular Performance (2GB RAM minimum)
- **Location:** Choose closest datacenter
- **SSH Key:** Add your public SSH key

### 2. Deploy XLN
```bash
# SSH into your server
ssh root@YOUR_SERVER_IP

# Download and run deployment script
curl -fsSL https://raw.githubusercontent.com/xlnfinance/xln/main/deploy-vultr.sh | bash
```

### 3. Access Your XLN Instance
- **Frontend:** `http://YOUR_SERVER_IP`
- **API:** `http://YOUR_SERVER_IP/api/`

## 📋 Manual Deployment Steps

If you prefer manual setup:

### 1. System Setup
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Bun
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

# Install tools
sudo apt install -y git nginx pm2
```

### 2. Clone and Build
```bash
# Clone repository
git clone https://github.com/xlnfinance/xln.git
cd xln

# Install dependencies
bun install

# Build frontend
cd frontend
bun install
bun run build
cd ..
```

### 3. Configure Services

#### PM2 Process Manager
```bash
# Create PM2 config
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
    max_memory_restart: '1G'
  }]
}
EOF

# Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

#### Nginx Reverse Proxy
```bash
# Create Nginx config
sudo tee /etc/nginx/sites-available/xln << 'EOF'
server {
    listen 80;
    server_name _;
    
    location / {
        root /home/ubuntu/xln/frontend/build;
        try_files $uri $uri/ /index.html;
    }
    
    location /api/ {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
EOF

# Enable site
sudo ln -sf /etc/nginx/sites-available/xln /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo systemctl restart nginx
```

## 🔧 Management Commands

### Application Management
```bash
# Check status
pm2 status

# View logs
pm2 logs xln-server

# Restart application
pm2 restart xln-server

# Update application
cd ~/xln
git pull origin main
bun install
cd frontend && bun run build && cd ..
pm2 restart xln-server
```

### Server Management
```bash
# Check Nginx status
sudo systemctl status nginx

# Restart Nginx
sudo systemctl restart nginx

# Check server resources
htop

# View system logs
journalctl -f
```

## 🔍 Troubleshooting

### Common Issues

#### Port 8080 Already in Use
```bash
# Kill process using port 8080
sudo lsof -ti:8080 | xargs sudo kill -9

# Restart XLN
pm2 restart xln-server
```

#### Nginx Configuration Error
```bash
# Test Nginx config
sudo nginx -t

# View Nginx error logs
sudo tail -f /var/log/nginx/error.log
```

#### Frontend Not Loading
```bash
# Check if build directory exists
ls -la ~/xln/frontend/build/

# Rebuild frontend
cd ~/xln/frontend
bun run build
sudo systemctl restart nginx
```

### Log Locations
- **Application logs:** `~/xln/logs/`
- **PM2 logs:** `~/.pm2/logs/`
- **Nginx logs:** `/var/log/nginx/`
- **System logs:** `journalctl -u nginx`

## 🔒 Security Considerations

### Firewall Setup
```bash
# Install UFW
sudo apt install ufw

# Allow SSH, HTTP, HTTPS
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443

# Enable firewall
sudo ufw --force enable
```

### SSL Certificate (Optional)
```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Get SSL certificate
sudo certbot --nginx -d your-domain.com

# Auto-renewal
sudo crontab -e
# Add: 0 12 * * * /usr/bin/certbot renew --quiet
```

## 📊 Monitoring

### Resource Monitoring
```bash
# Real-time monitoring
htop

# Disk usage
df -h

# Memory usage
free -h

# Network usage
netstat -tuln
```

### Application Monitoring
```bash
# PM2 monitoring
pm2 monit

# Application metrics
pm2 status

# Detailed process info
pm2 show xln-server
```

## 🚀 Performance Optimization

### PM2 Cluster Mode
```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'xln-server',
    script: 'bun',
    args: 'run dev',
    instances: 'max', // Use all CPU cores
    exec_mode: 'cluster'
  }]
}
```

### Nginx Caching
```nginx
# Add to server block
location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

## 📱 Mobile Access

Your XLN instance will be accessible from mobile devices at:
`http://YOUR_SERVER_IP`

For better mobile experience, consider:
- Adding SSL certificate
- Using a custom domain
- Configuring PWA features

---

**Need help?** Check the logs and ensure all services are running:
```bash
pm2 status && sudo systemctl status nginx
```
