#!/bin/bash

forever stopall
killall Failsafe 2>/dev/null

rm -rf data*
node fs --genesis=test

db=mysql:root:123123
maxport=8012

ttab 'node fs.js -p8443  --db=$db'
for i in $(seq 8001 $maxport); do
  rsync -q -rva --exclude=offchain data/* data$i
  cmd="ttab 'node fs.js -p$i --username=$i --pw=password 
  --datadir=data$i --db=$db'"
  if (( i < 8004 )); then
    NODE_ENV=production ${cmd}
  else
    NODE_ENV=production ${cmd} --monkey=$maxport --silent
  fi
done
