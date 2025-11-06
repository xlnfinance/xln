#!/bin/bash
# Auto-deploy script - run after every git push

ssh -i ~/.ssh/xln_deploy root@xln.finance << 'ENDSSH'
cd /root/xln
git pull origin main
cd frontend
npm run build
cp -r build/* /var/www/html/
echo "✅ Deployed at $(date)"
ENDSSH
