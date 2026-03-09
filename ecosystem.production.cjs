const path = require('path');

const root = __dirname;

module.exports = {
  apps: [
    {
      name: 'xln-server',
      script: path.join(root, 'scripts/start-server.sh'),
      interpreter: '/bin/bash',
      cwd: root,
      error_file: '/root/.pm2/logs/xln-server-error.log',
      out_file: '/root/.pm2/logs/xln-server-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      max_memory_restart: '800M',
      autorestart: true,
      watch: false,
      kill_timeout: 5000,
      wait_ready: false,
      listen_timeout: 30000,
    },
    {
      name: 'xln-custody',
      script: path.join(root, 'scripts/start-custody.sh'),
      interpreter: '/bin/bash',
      cwd: root,
      error_file: '/root/.pm2/logs/xln-custody-error.log',
      out_file: '/root/.pm2/logs/xln-custody-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      max_memory_restart: '500M',
      autorestart: true,
      watch: false,
      kill_timeout: 5000,
      wait_ready: false,
      listen_timeout: 30000,
    },
  ],
};
