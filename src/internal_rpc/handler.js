const Router = require('../router')

let respondNotAuthorized = (ws) => {
  if (ws.end) {
    ws.end(
      JSON.stringify({
        authorized: false
      })
    )
  } else {
    ws.send(
      JSON.stringify({
        result: cached_result
      })
    )
  }
}

let setBrowser = (ws) => {
  // new window replaces old one
  if (me.browser && me.browser.readyState == 1) {
    me.browser.send(
      JSON.stringify({
        result: {already_opened: true}
      })
    )
  }

  me.browser = ws
}

module.exports = async (ws, json) => {
  // prevents all kinds of CSRF and DNS rebinding
  // strong coupling between the console and the browser client

  if (json.auth_code != PK.auth_code && ws != 'admin') {
    //if (!json.auth_code) {
    return respondNotAuthorized(ws)
  }

  if (ws.send && json.is_wallet && me.browser != ws) {
    setBrowser(ws)
  }

  let result = {}
  switch (json.method) {
    case 'load':
      result = await require('./load')(json.params)
      break

    case 'logout':
      result = require('./logout')()
      break

    case 'send':
      await me.payChannel(json.params)
      break

    case 'rebalance':
      await require('./rebalance')(json.params)
      return false
      break

    case 'broadcast':
      me.broadcast(json.params)
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

    case 'requestInsurance':
      let ch = await me.getChannel(
        fromHex(json.params.partnerId),
        json.params.asset
      )

      me.send(
        ch.hub,
        'setLimits',
        me.envelope(methodMap('requestInsurance'), ch.d.asset)
      )
      react({confirm: 'Requested insurance, please wait'})
      break

    case 'toggleHub':
      let index = PK.usedHubs.indexOf(json.params.id)
      if (index == -1) {
        PK.usedHubs.push(json.params.id)

        let hub = K.hubs.find((h) => h.id == json.params.id)

        require('./set_limits')({
          chActions: [
            {
              partnerId: hub.pubkey,
              hard_limit: K.hard_limit,
              soft_limit: K.soft_limit,
              asset: 1
            }
          ]
        })

        result.confirm = 'Hub added'
      } else {
        // ensure no connection
        PK.usedHubs.splice(index, 1)

        result.confirm = 'Hub removed'
      }
      //
      react({}, true)
      //update_cache()

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

    case 'login':
      require('./login')(ws, json.proxyOrigin)
      return false
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
    /*ws.send(
      JSON.stringify({
        result: Object.assign(result, cached_result)
      })
    )*/
    react(result)
  }
}
