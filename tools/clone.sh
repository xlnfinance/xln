cd ..
rsync -q -rva --exclude=offchain data/* data8002
node fs.js -p8002 --username=second --pw=password --datadir=data8002