# Development and private genesis

Look into `tools/genesis.js` to modify initial parameters such as Byzantine tolerance (you can set 0 and have single server building blocks, or 333 for a thousand).

You can increase blocktime or change gas cost along with other network settings.

## Local Simulation

`./install` then run `./simulate` to bootstrap local dev blockchain with 4 validators on different ports (8443, 8001, 8002, 8003) each having one Fair share.

8443 is also a hub @main. At bootstrap there are various end-2-end tests performed on a live network, which is a great way to see if all components fit together. Different users at different times turn on different times and verify the result with setTimeout.



## Using live network

Perfect way to run new code against old blockchain:

```
rm -rf fs
id=fs
f=Fair-1.tar.gz
mkdir $id && cd $id && curl https://fairlayer.com/$f -o $f
tar -xzf $f && rm $f
ln -s ~/work/fs/node_modules
ln -s ~/work/fs/wallet/node_modules wallet/node_modules
rm -rf ./src
ln -s ~/work/fs/src
node fs -p8001
```