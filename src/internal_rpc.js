// Internal RPC serves requests made by the user's browser or by the merchant server app
const derive = require('./derive')

respondNotAuthorized = (ws) => {
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

setBrowser = () => {
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

internalRPCLoad = async (p) => {
  let result = {}
  if (p.username) {
    //do we need to check for pw?
    var seed = await derive(p.username, p.pw)
    await me.init(p.username, seed)
    await me.start()

    result.confirm = 'Welcome!'
  }

  return result
}

internalRPCLogout = () => {
  me.intervals.map(clearInterval)
  if (me.external_wss_server) {
    me.external_wss_server.close()
    me.external_wss.clients.forEach((c) => c.close())
    // Object.keys(me.users).forEach( c=>me.users[c].end() )
  }

  me = new Me()

  let result = {pubkey: null}
  return result
}

internalRPCDispute = async (p) => {
  var ch = await me.getChannel(
    K.hubs.find((m) => m.id == p.partner).pubkey,
    p.asset
  )
  await ch.d.startDispute(p.profitable)

  let result = {confirm: 'Started a Dispute'}
  return result
}

internalRPCRebalance = async (p) => {
  var ins = []
  var outs = []
  var asset = parseInt(p.asset)

  for (o of p.outs) {
    // split by @
    if (o.to.length > 0) {
      var to = o.to.split('@')

      if (to[0].length == 64) {
        var userId = Buffer.from(to[0], 'hex')

        // maybe this pubkey is already registred?
        var u = await User.idOrKey(userId)

        if (u.id) {
          userId = u.id
        }
      } else {
        var userId = parseInt(to[0])

        var u = await User.idOrKey(userId)

        if (!u) {
          result.alert = 'User with short ID ' + userId + " doesn't exist."
          break
        }
      }

      if (o.amount.indexOf('.') == -1) o.amount += '.00'

      var amount = parseInt(o.amount.replace(/[^0-9]/g, ''))

      if (amount > 0) {
        outs.push([
          amount,
          userId,
          to[1] ? parseInt(to[1]) : 0,
          o.invoice ? Buffer.from(o.invoice, 'hex') : 0
        ])
      }
    }
  }

  if (p.request_amount > 0) {
    var partner = K.hubs.find((m) => m.id == p.partner)
    var ch = await me.getChannel(partner.pubkey, asset)
    if (p.request_amount > ch.insured) {
      react({alert: 'More than you can withdraw from insured'})
      return
    } else {
      react({confirm: 'Requested withdrawals...'})
    }
    me.send(
      partner,
      'requestWithdrawFrom',
      me.envelope(p.request_amount, asset)
    )

    // waiting for the response
    setTimeout(async () => {
      var ch = await me.getChannel(partner.pubkey, asset)
      if (ch.d.input_sig) {
        ins.push([ch.d.input_amount, ch.d.partnerId, ch.d.input_sig])

        me.batch.push(['withdrawFrom', asset, ins])
        me.batch.push(['depositTo', asset, outs])
        react({confirm: 'Onchain rebalance tx added to queue'})
      } else {
        react({
          alert: 'Failed to obtain withdrawal. Try later or start a dispute.'
        })
      }
    }, 3000)
  } else if (outs.length > 0) {
    // no withdrawals
    me.batch.push(['depositTo', asset, outs])

    if (me.batch.length == 0) {
      react({alert: 'Nothing to send onchain'})
    } else {
      react({confirm: 'Wait for tx to be added to blockchain'})
    }
  }
}

internalRPCCreate_asset = (p) => {
  me.batch.push(['createAsset', [p.ticker, parseInt(p.amount), p.name, p.desc]])
}

internalRPCCreateOrder = (p) => {
  let amount = parseInt(p.order.amount)
  let asset = parseInt(p.asset)
  if (amount > 0) {
    if (amount > me.record.asset(asset) + p.request_amount) {
      // more than you can theoretically have even after withdrawal
      react({alert: 'Not enough funds to trade this amount'})
    } else {
      me.batch.push([
        'createOrder',
        [
          asset,
          parseInt(parseFloat(amount) * 100),
          parseInt(p.order.buyAssetId),
          parseInt(parseFloat(p.order.rate) * 1000000)
        ]
      ])
    }
  }
}

internalRPCCancelOrder = (p) => {
  me.batch.push(['cancelOrder', [p.id]])
}

internalRPCGetinfo = () => {
  // returns generic info about current account and the network
  let result = {}
  result.address = me.address
  result.assets = cached_result.assets //await Asset.findAll()

  return result
}

internalRPCPropose = (p) => {
  if (p[0].length <= 1) throw 'Rationale is required'

  if (p[2]) {
    // for some reason execSync throws but gives result
    try {
      // exclude all non-JS files for now
      p[2] = child_process.execSync(
        'diff  -Naur --exclude=*{.cache,data,dist,node_modules,private,spec,.git}  ../8001 . '
      )
    } catch (err) {
      p[2] = err.stdout
    }
  }

  me.batch.push(['propose', p])
  let result = {confirm: 'Proposed'}

  return result
}

internalRPCVote = (p) => {
  me.batch.push(['vote', [p.id, p.approval, p.rationale]])
  let result = {confirm: 'Voted'}

  return result
}

internalRPCSync = () => {
  sync()
  let result = {confirm: 'Syncing the chain...'}

  return result
}

internalRPCLogin = (ws, proxyOrigin) => {
  // Successor of Secure Login, returns signed origin
  ws.send(
    JSON.stringify({
      result: toHex(nacl.sign(Buffer.from(proxyOrigin), me.id.secretKey))
    })
  )
}

internalRPCReceivedAndFailed = async () => {
  await me.syn

  let result = {}

  // what we successfully received and must deposit in our app +
  // what node failed to send so we must deposit it back to user's balance
  result.receivedAndFailed = await Payment.findAll({
    where: {
      type: 'del',
      status: 'ack',
      processed: false,
      [Op.or]: [{is_inward: true}, {is_inward: false, secret: null}]
    }
  })

  // mark as processed
  if (result.receivedAndFailed.length > 0) {
    await Payment.update(
      {processed: true},
      {
        where: {
          type: 'del',
          status: 'ack',
          [Op.or]: [{is_inward: true}, {is_inward: false, secret: null}]
        }
      }
    )
  }

  return result
}

internalRPCTestnet = (p) => {
  if (p.action == 4) {
    me.CHEAT_dontack = 1
  } else if (p.action == 5) {
    me.CHEAT_dontreveal = 1
  } else if (p.action == 6) {
    me.CHEAT_dontwithdraw = 1
  } else {
    me.getCoins(p.asset, parseInt(p.faucet_amount))
    /*
    me.send(
      Members.find((m) => m.id == p.partner),
      'testnet',
      concat(bin([p.action, p.asset]), bin(me.address))
    )*/
  }

  let result = {confirm: 'Testnet action triggered'}
  return result
}

internalRPCSetLimits = async (p) => {
  // sets credit limits to a hub
  let result = {}
  let m = K.hubs.find((m) => m.id == p.partner)

  if (!m) return result

  let ch = await me.getChannel(m.pubkey, p.asset)
  ch.d.soft_limit = parseInt(p.limits[0]) * 100
  ch.d.hard_limit = parseInt(p.limits[1]) * 100
  await ch.d.save()

  me.send(
    m,
    'setLimits',
    me.envelope(map('setLimits'), ch.d.asset, ch.d.soft_limit, ch.d.hard_limit)
  )

  result.confirm = 'Credit limits updated'
  return result
}

module.exports = async (ws, json) => {
  // prevents all kinds of CSRF and DNS rebinding
  // strong coupling between the console and the browser client

  if (json.auth_code != PK.auth_code && ws != 'admin') {
    return respondNotAuthorized()
  }

  if (ws.send && json.is_wallet && me.browser != ws) {
    setBrowser()
  }

  let result = {}
  switch (json.method) {
    case 'load':
      result = await internalRPCLoad(json.params)
      break

    case 'logout':
      result = internalRPCLogout()
      break

    case 'dispute':
      result = await internalRPCDispute(json.params)
      break

    case 'send':
      await me.payChannel(json.params)
      break

    case 'rebalance':
      await internalRPCRebalance(json.params)
      return false
      break

    case 'createAsset':
      internalRPCCreate_asset(json.params)
      react({confirm: 'Added to batch'})
      break

    case 'createHub':
      // nothing yet ಠ_ಠ
      react({confirm: 'Added to batch'})
      break

    case 'createOrder':
      internalRPCCreateOrder(json.params)
      react({confirm: 'Added to batch'})
      break

    case 'cancelOrder':
      internalRPCCancelOrder(json.params)
      react({confirm: 'Added to batch'})
      break

    case 'getinfo':
      result = internalRPCGetinfo()
      break

    case 'propose':
      result = internalRPCPropose(json.params)
      break

    case 'vote':
      result = internalRPCVote(json.params)
      break

    case 'sync':
      result = internalRPCSync(json.params)
      break

    case 'login':
      internalRPCLogin(ws, json.proxyOrigin)
      return false
      break

    // commonly called by merchant app on the same server
    case 'receivedAndFailed':
      result = await internalRPCReceivedAndFailed()
      break

    case 'testnet':
      result = internalRPCTestnet(json.params)
      break

    case 'hardfork':
      //security: ensure it's not RCE and put extra safeguards
      //eval(p.hardfork)
      result.confirm = 'Executed'
      break

    case 'setLimits':
      result = await internalRPCSetLimits(json.params)
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
