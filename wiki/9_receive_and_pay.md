# Receive and Send API of Fairlayer

Fairlayer was engineered to be easy to integrate. It's just one pulling HTTP request to get newly received unprocessed payments and one request to send one. 

It seamlessly implements both onchain (direct rebalance of insurance from you@hub to receiver@hub channel) and offchain (through payment channels not touching onchain layer) transfers, depending on the amount and how busy the network is. 

We believe long term only offchain payments will be used, even for large payments, for in the beginning while the onchain space is cheap we also offer direct rebalance.

## Authentication

All requests to Fair daemon must be authenticated with `auth_code` stored in `/data/offchain/pk.json`. You can read that value at bootstrap of your app or simply pass it as an ENV variable.

For simplicity we will use GET and pass params as a GET query, but you can also use POST and pass JSON in the body.

You can modify the port Fair daemon occupies on your server. Pass `-pXXXX` to the daemon to use another port. We are using 8002 below by default. For higher security, make sure the daemon is not exposed to external world (even though all the actions are authorized with security code).

Put this helper in util libs:

```
FairRPC = (params, cb) => {
	http.get('http://127.0.0.1:8002/rpc?auth_code=AUTH_CODE&'+params, (res) => {
	  let rawData = '';
	  res.on('data', (chunk) => { rawData += chunk; });
	  res.on('end', () => {
	    try {
	      const parsedData = JSON.parse(rawData);
	      cb(parsedData);
	    } catch (e) {
	      console.error(e.message);
	    }
	  });
	}).on('error', (e) => {
	  console.error(`Got error: ${e.message}`);
	});
}
```

## Receive

The app that integrates Fair should set up a periodic pulling request e.g. every 1 second:

```
FairRPC('method=receivedAndFailed', (r)=>{
  if (!r.receivedAndFailed) return
  for (obj of r.receivedAndFailed) {
    // is it received inward or failed outward?

  }
})
```

This returns unprocessed received payments from outside and transfers that the node failed to sent (due to capacity issues or the receiver being offline for example) which the app should credit back to users balance.

All payments have an invoice field that somehow refers to the user this object belongs. It can be a primary key ID in the database, email, or somehow obfuscated user id, or purchase id if you don't have registration. 

Previously in Bitcoin and other blockchains you would have to generate a new address for every payment, this is no longer the case. Now all payments go to the same address carrying a special tag "invoice" that helps the receiver recognize what is this payment for. This technique is applied both in offchain and onchain payments (onchain invoice is never stored in blockchain state afterwards). 

Note that if your node does not make payments and receives them only, you may ignore failed outgoing payments as you don't expect to ever have them anyway.

After a request is finished all payments in it are marked as `processed` so they won't be returned ever again. If your app was shut down unexpectedly after triggering this method, you need to manually re-credit the payments that are now marked as `processed` in the Fair daemon.

## Send

Say, you are an exchange and your user wants to withdraw some asset to their Fair wallet.

First, you need to check if they have enough money, then reduce their balance by the amount they want to withdraw. 

Then make a request to your local Fair daemon with **following parameters carefully escaped and sanitized**

```
FairRPC('method=send&outward[destination]=DEST&outward[asset]=1&outward[amount]=200&outward[invoice]=INVOICE', (r)=>{
  if (!r.receivedAndFailed) return
  for (obj of r.receivedAndFailed) {
    // is it received or failed?

  }
})
```



If the outward payment fails (rare, but possible), you will receive it as a failed outward via a pulling request above, then you can credit funds back.




