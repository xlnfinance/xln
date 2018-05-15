#!/bin/bash

forever stopall
killall Failsafe 2>/dev/null

rm -rf data*

db=mysql:root:123123
maxport=8008


node fs --genesis=test --db=$db
ttab 'node fs.js -p8443  --db=$db'
for i in $(seq 8001 $maxport); do
  rsync -q -rva --exclude=offchain data/* data$i
  cmd="node fs.js -p$i --username=$i --pw=password 
  --datadir=data$i --db=$db"
  if (( i < 8003 )); then
    ttab "${cmd}"
  else
    ${cmd} --monkey=$maxport --silent &
  fi
done
