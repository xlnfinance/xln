#!/bin/bash

forever stopall
killall Failsafe 2>/dev/null

rm -rf data*
node fs --genesis=test

db=mysql:root:123123
maxport=8012

NODE_ENV=production forever start fs.js -p8443 --silent --db=$db --monkey=$maxport --CHEAT=dontprecommit

for i in $(seq 8001 $maxport); do
  rsync -q -rva --exclude=offchain data/* data$i
  cmd="forever start fs.js -p$i --username=$i --pw=password --silent --datadir=data$i --db=$db"
  if (( i < 8004 )); then
    NODE_ENV=production ${cmd}
  else
    NODE_ENV=production ${cmd} --monkey=$maxport
  fi
done
