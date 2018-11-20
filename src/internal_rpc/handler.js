const Router = require('../router')
const withdraw = require('../offchain/withdraw')

/*
let setBrowser = (ws) => {
  // new window replaces old one
  if (me.browser && me.browser.readyState == 1) {
    me.browser.send(JSON.stringify({already_opened: true}))
  }

  me.browser = ws
}
*/

module.exports = async (ws, json) => {
  // prevents all kinds of CSRF and DNS rebinding
  // strong coupling between the console and the browser client

  // public RPC, return cached_result only
  if (json.auth_code != PK.auth_code && ws != 'admin') {
    //if (!json.auth_code) {
    //l('Not authorized')
    let resp =
      json.method == 'login'
        ? {alert: 'Invalid auth_code, restart node'}
        : cached_result
    ws[ws.end ? 'end' : 'send'](JSON.stringify(resp))

    return
  }

  if (ws.send && json.is_wallet && !me.browsers.includes(ws)) {
    me.browsers.push(ws)
    //setBrowser(ws)
  }

  // internal actions that require authorization

  var result = {}
  switch (json.method) {
    case 'load':
      // triggered by frontend to update

      // public + private info
      //react({public: true, private: true, force: true})
      //return

      break
    case 'login':
      await require('./login')(json.params)
      return

      break

    case 'logout':
      result = require('./logout')()
      break

    case 'sendOffchain':
      await me.payChannel(json.params)
      break

    case 'startDispute':
      let ch = await Channel.get(json.params.partnerId)
      me.batchAdd('disputeWith', await startDispute(ch))
      react({confirm: 'OK'})

      break
    case 'withChannel':
      require('./with_channel')(json.params)
      break

    case 'onchainFaucet':
      json.params.pubkey = me.pubkey.toString()
      json.params.action = 'onchainFaucet'
      me.sendJSON(K.hubs[0], 'testnet', json.params)
      react({confirm: 'Await onchain faucet'})

      break

    case 'externalDeposit':
      require('./external_deposit')(json.params)
      break

    case 'broadcast':
      Periodical.broadcast(json.params)
      react({force: true})
      return false
      break

    case 'createAsset':
      require('./create_asset')(json.params)
      react({confirm: 'Added to batch', force: true})
      break

    case 'createHub':
      require('./create_hub')(json.params)

      react({confirm: 'Added to batch'})
      break

    case 'createOrder':
      require('./create_order')(json.params)
      react({confirm: 'Added to batch'})
      break

    case 'cancelOrder':
      require('./cancel_order')(json.params)
      react({confirm: 'Added to batch'})
      break

    case 'getRoutes':
      result.bestRoutes = await Router.bestRoutes(
        json.params.address,
        json.params
      )
      break

    case 'clearBatch':
      me.batch = []
      react({confirm: 'Batch cleared'})
      break

    case 'toggleHub':
      let index = PK.usedHubs.indexOf(json.params.id)
      if (index == -1) {
        PK.usedHubs.push(json.params.id)

        let hub = K.hubs.find((h) => h.id == json.params.id)

        require('./with_channel')({
          op: 'setLimits',
          partnerId: hub.pubkey,
          asset: 1,
          soft_limit: K.soft_limit,
          hard_limit: K.hard_limit
        })

        result.confirm = 'Hub added'
      } else {
        // ensure no connection
        PK.usedHubs.splice(index, 1)

        result.confirm = 'Hub removed'
      }
      //
      react({force: true})
      //Periodical.updateCache()

      break
    case 'toggleAsset':
      if ([1, 2].includes(json.params.id)) {
        react({alert: 'This asset is required by the system'})
        return
      }
      let assetIndex = PK.usedAssets.indexOf(json.params.id)
      if (assetIndex == -1) {
        PK.usedAssets.push(json.params.id)

        result.confirm = 'Asset added'
      } else {
        PK.usedAssets.splice(assetIndex, 1)

        result.confirm = 'Asset removed'
      }
      react({force: true})

      break

    case 'getinfo':
      result = require('./get_info')()
      break

    case 'propose':
      result = require('./propose')(json.params)
      break

    case 'vote':
      result = require('./vote')(json.params)
      break

    case 'sync':
      result = require('./sync')(json.params)
      break

    // commonly called by merchant app on the same server
    case 'receivedAndFailed':
      result = await require('./received_and_failed')(ws)
      break

    case 'hardfork':
      //security: ensure it's not RCE and put extra safeguards
      //eval(json.params.hardfork)
      result.confirm = 'Executed'
      break

    default:
      result.alert = 'No method provided'
  }

  result.authorized = true

  react({public: true, private: true, force: json.method == 'load'})

  // http or websocket?
  if (ws.end) {
    ws.end(JSON.stringify(result))
  } else if (ws == 'admin') {
    return result
  } else {
    ws.send(JSON.stringify(result))
    //react(result)
  }
}
