# Receive and Send API of Fairlayer

Fairlayer was engineered to be ridiculously easy to integrate. It's just one repeating pulling HTTP request to get newly received unprocessed payments and one request to make a payment. 

It seamlessly implements both onchain (direct rebalance of insurance from you@hub to receiver@hub channel) and offchain (through payment channels not touching onchain layer) transfers, depending on the amount and how busy the network is. 

We believe long term only offchain payments will be used, even for large payments, but in the beginning while the onchain space is cheap we also offer direct rebalance.

## Integration Demos

[Check out this repository with different demos.](https://github.com/fairlayer/demos). No packaged SDK is offered because it would increase your attack surface and the API is very simple.

## Authentication

All requests to Fair daemon must be authenticated with `auth_code` stored in `/data/offchain/pk.json`. You can read that value at bootstrap of your app or simply pass it as an ENV variable.

For simplicity we will use GET and pass params as a GET query, but you can also use POST and pass JSON in the body.

You can modify the port Fair daemon occupies on your server. Pass `-pXXXX` to the daemon to use another port. We are using 8002 below by default. For higher security, make sure the daemon is not exposed to external world (even though all the actions are authorized with security code).

Put something like this helper in util libs:

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

For someone to pay they need destination address, an amount and optional invoice parameter.

You can read your own address at bootstrap or have it hardcoded 

```
FairRPC('method=getinfo', (r)=>{
  console.log('My address', r.address)
})
```

Once you have an address, you can make a button "Pay with Fair" or simply show the address having onclick action. This action should open user's local Fair wallet with all the values prefilled:

```
var fs_origin = 'http://127.0.0.1:8001'
deposit.onclick = function(){
fs_w = window.open(fs_origin+'#wallet?invoice='+id+"&address=${address}&amount=10")

window.addEventListener('message', function(e){
  if(e.origin != fs_origin) return

  fs_w.close()
  setTimeout(()=>{
    // give the backend time to process this deposit
    location.reload()
  }, 1000)
})
}
```

Once the user reviews payment details, enters the amount if needed and clicks Pay, Fairlayer does the rest. Under the hood user's wallet encrypts a specific hash for the public key stored in your address, passes it to the hub, the hub finds websocket towards your daemon, passes the payment with same condition but smaller amount (minus hub's fees), your daemon decrypts the originally encrypted hashlock, returns the secret to the hub (at this point you are guaranteed to get the money, as you have the dispute proof with hashlock that you can unlock in it), the hub returns the secret to the user and now the payment is finished. 

The user's wallet makes a postMessage event to the opener to notify your app's about successful payment.

The app that integrates Fair should set up a periodic pulling request to the daemon e.g. every 1 second:

```
FairRPC('method=receivedAndFailed', (r)=>{
  if (!r.receivedAndFailed) return
  for (obj of r.receivedAndFailed) {
    if (obj.asset != 1) {
    // always whitelist assets you're planning to support
    return 
    }

    let uid = Buffer.from(obj.invoice, 'hex').toString()

    // checking if uid is valid
    if (users.hasOwnProperty(uid)) {
      if (obj.is_inward) {
        l("Received deposit "+uid)
      } else {
        l("Refund failed send "+uid)
      }
      // credit obj.amount of obj.asset to user=uid
      users[uid] += obj.amount
    }
  }
})
```

This returns unprocessed received payments from outside and transfers that the node failed to sent (due to capacity issues or the receiver being offline for example) which the app should credit back to users balance.

All payments have an invoice field that somehow refers to the user this object belongs. It can be a primary key ID in the database, email, or somehow obfuscated user id, or purchase id if you don't have registration. [Similar to Destination Tag in Ripple](https://forum.ripple.com/viewtopic.php?f=5&t=7496)

Previously in Bitcoin and other blockchains you would have to generate a new address for every payment, this is no longer the case. Now all payments go to the same address carrying a special tag "invoice" that helps the receiver recognize what is this payment for. This technique is applied both in offchain and onchain payments (onchain invoice is never stored in blockchain state afterwards). 

Note that if your node does not make payments and receives them only, you may ignore failed outgoing payments as you don't expect to ever have them anyway.

After a request is finished all payments in it are marked as `processed` so they won't be returned ever again. If your app was shut down unexpectedly after triggering this method, you need to manually re-credit the payments that are now marked as `processed` in the Fair daemon.

## Send

Say, you are an exchange and your user wants to withdraw some asset to their Fair wallet.

First, you need to check if they have enough money, then reduce their balance by the amount they want to withdraw. Make sure you pessimistically locked user account before withdrawal [to avoid race conditions.](https://sakurity.com/blog/2015/05/21/starbucks.html)

Then make a request to your local Fair daemon with **following parameters carefully escaped and sanitized**:

**required**
* `params[destination]` - the address where user wants to send assets
* `params[asset]` - id of asset to operate in. 1 for FRD, 2 for FRB and so on.

**optional**
* `params[amount]` - the amount of assets to send (fees are passed on the user). Can be editable.
* `params[invoice]` - set the same invoice you would use to receive assets from this user, so if the payment fails it will be credited back according to this invoice.
* `params[editable]` - don't want the user to mess around with parameters? Set to 'none' to disable all fields or to 'amount' if you want to keep amount editable.


```
FairRPC('method=send&params[destination]=ADDRESS&params[asset]=1&params[amount]=200&params[invoice]=INVOICE', (r)=>{
  // sent
})
```


If the outward payment fails (rare, but possible), you will receive it as a failed outward via a pulling receivedAndFailed request, then you can credit funds back.

## Fair Login

You can use built-in authenticator.

## Other endpoints

You can call other RPC endpoints, see internal_rpc.js for full reference.

# [Home](/wiki/start.md)



