const Router = require('../router')
const withdraw = require('../offchain/withdraw')

let setBrowser = (ws) => {
  // new window replaces old one
  if (me.browser && me.browser.readyState == 1) {
    me.browser.send(JSON.stringify({already_opened: true}))
  }

  me.browser = ws
}

module.exports = async (ws, json) => {
  // prevents all kinds of CSRF and DNS rebinding
  // strong coupling between the console and the browser client

  if (json.auth_code != PK.auth_code && ws != 'admin') {
    //if (!json.auth_code) {
    l('Not authorized')
    ws[ws.end ? 'end' : 'send'](JSON.stringify(cached_result))
    return
  }

  if (ws.send && json.is_wallet && me.browser != ws) {
    setBrowser(ws)
  }

  var result = {}
  switch (json.method) {
    case 'load':
      // triggered by frontend to update

      if (me.browser == ws) {
        // public + private info
        react(cached_result)
      } else {
        // public cache only
        result = cached_result
      }

      break
    case 'login':
      result = await require('./login')(json.params)
      break

    case 'logout':
      result = require('./logout')()
      break

    case 'sendOffchain':
      await me.payChannel(json.params)
      break

    case 'withChannel':
      require('./with_channel')(json.params)
      break

    case 'externalDeposit':
      require('./external_deposit')(json.params)
      break

    case 'broadcast':
      Periodical.broadcast(json.params)
      react({confirm: 'Now await inclusion in block'})
      return false
      break

    case 'createAsset':
      require('./create_asset')(json.params)
      react({confirm: 'Added to batch'})
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

        let ch = await me.getChannel(hub.pubkey, 1)

        ch.d.hard_limit = K.hard_limit
        ch.d.soft_limit = K.soft_limit

        me.send(
          hub,
          'setLimits',
          me.envelope(
            methodMap('setLimits'),
            ch.d.asset,
            ch.d.soft_limit,
            ch.d.hard_limit
          )
        )

        result.confirm = 'Hub added'
      } else {
        // ensure no connection
        PK.usedHubs.splice(index, 1)

        result.confirm = 'Hub removed'
      }
      //
      react({}, true)
      //Periodical.updateCache()

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
      result = await require('./received_and_failed')()
      break

    case 'testnet':
      result = require('./testnet')(json.params)
      break

    case 'hardfork':
      //security: ensure it's not RCE and put extra safeguards
      //eval(json.params.hardfork)
      result.confirm = 'Executed'
      break

    case 'setLimits':
      result = await require('./set_limits')(json.params)
      break

    default:
      result.alert = 'No method provided'
  }

  result.authorized = true

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
