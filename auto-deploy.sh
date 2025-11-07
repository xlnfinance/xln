#!/bin/bash
# Auto-deploy script - run after every git push
# IMPORTANT: Run `npm run test:landing` locally BEFORE pushing

set -e  # Exit on any error

ssh -i ~/.ssh/xln_deploy root@xln.finance << 'ENDSSH'
cd /root/xln
git pull origin main
cd frontend
npm run build
cp -r build/* /var/www/html/
echo "✅ Deployed at $(date)"
ENDSSH
