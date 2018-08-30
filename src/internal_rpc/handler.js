const Router = require('../router')
const withdraw = require('../offchain/withdraw')

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
      result = Object.assign(result, cached_result)
      break

    case 'logout':
      result = require('./logout')()
      break

    case 'sendOffchain':
      await me.payChannel(json.params)
      break

    case 'withChannel':
      // perform a specific operation on given channel
      let d = await Delta.findById(json.params.id)
      let ch = await me.getChannel(d.partnerId, d.asset, d)

      if (json.params.op == 'withdraw') {
        if (json.params.amount > ch.insured) {
          react({alert: 'More than you can withdraw from insured'})
          return
        }
        await withdraw(ch, json.params.amount)
        if (ch.d.withdrawal_sig == null) {
          react({
            alert:
              'Failed to get withdrawal from: ' +
              ch.hub.handle +
              '. Try later or start a dispute.'
          })
          return
        }

        me.batch.push([
          'withdrawFrom',
          ch.d.asset,
          [[ch.d.withdrawal_amount, ch.partner, ch.d.withdrawal_sig]]
        ])
        result.confirm = 'OK'
      } else if (json.params.op == 'deposit') {
        me.batch.push([
          'depositTo',
          ch.d.asset,
          [[json.params.amount, me.record.id, ch.partner, 0]]
        ])
        result.confirm = 'OK'
      } else if (json.params.op == 'dispute') {
        me.batch.push([
          'disputeWith',
          ch.d.asset,
          [await deltaGetDispute(ch.d)]
        ])
        result.confirm = 'OK'
      } else if (json.params.op == 'setLimits') {
        ch.d.hard_limit = json.params.hard_limit
        ch.d.soft_limit = json.params.soft_limit

        // nothing happened
        if (!ch.d.changed()) {
          return
        }

        await ch.d.save()

        l('set limits to ', ch.hub)

        me.send(
          ch.hub,
          'setLimits',
          me.envelope(
            methodMap('setLimits'),
            ch.d.asset,
            ch.d.soft_limit,
            ch.d.hard_limit
          )
        )

        result.confirm = 'OK'
      } else if (json.params.op == 'requestInsurance') {
        me.send(
          ch.hub,
          'setLimits',
          me.envelope(methodMap('requestInsurance'), ch.d.asset)
        )

        react({confirm: 'Requested insurance, please wait'})
      } else if (json.params.op == 'testnet') {
        if (json.params.action == 4) {
          me.CHEAT_dontack = 1
        } else if (json.params.action == 5) {
          me.CHEAT_dontreveal = 1
        } else if (json.params.action == 6) {
          me.CHEAT_dontwithdraw = 1
        } else {
          me.testnet({
            action: 1,
            asset: 1,
            amount: json.params.amount,
            partner: ch.partner
          })
        }

        let result = {confirm: 'Testnet action triggered'}
      }

      break

    case 'externalDeposit':
      // split by @
      let dep = json.params
      if (dep.to.length > 0) {
        let to = dep.to
        let userId

        // looks like a pubkey
        if (to.length == 64) {
          userId = Buffer.from(to, 'hex')

          // maybe this pubkey is already registred?
          let u = await getUserByIdOrKey(userId)

          if (u.id) {
            userId = u.id
          }
        } else {
          // looks like numerical ID
          userId = parseInt(to)

          let u = await getUserByIdOrKey(userId)

          if (!u) {
            result.alert = 'User with short ID ' + userId + " doesn't exist."
            break
          }
        }

        let amount = parseInt(dep.depositAmount)

        let withPartner = 0
        // @onchain or @0 mean onchain balance
        if (dep.hub && dep.hub != 'onchain') {
          // find a hub by its handle or id
          let h = K.hubs.find((h) => h.handle == dep.hub || h.id == dep.hub)
          if (h) {
            withPartner = h.id
          } else {
            react({alert: 'No such hub'})
            return
          }
        }

        if (amount > 0) {
          me.batch.push([
            'depositTo',
            json.params.asset,
            [
              [
                amount,
                userId,
                withPartner,
                dep.invoice ? Buffer.from(dep.invoice, 'hex') : 0
              ]
            ]
          ])
        }
      }
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
