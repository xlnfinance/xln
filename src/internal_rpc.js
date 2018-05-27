// Internal RPC serves requests made by the user's browser or by the merchant server app

module.exports = async (ws, msg) => {
  var result = {}

  var json = parse(bin(msg).toString())

  // prevents all kinds of CSRF and DNS rebinding
  // strong coupling between the console and the browser client

  // temporary: no auth code in dev mode for non roots
  if (json.auth_code == PK.auth_code) {
    if (ws.send && json.is_wallet && me.browser != ws) {
      if (me.browser && me.browser.readyState == 1) {
        ws.send(
          JSON.stringify({
            result: {already_opened: true}
          })
        )
      } else {
        // used to react(). only one instance is allowed
        me.browser = ws
      }
    }

    let p = json.params

    switch (json.method) {
      case 'load':
        if (p.username) {
          var seed = await derive(p.username, p.pw)
          await me.init(p.username, seed)
          await me.start()

          result.confirm = 'Welcome!'
        }

        break
      case 'logout':
        me.intervals.map(clearInterval)

        if (me.member_server) {
          me.member_server.close()
          me.external_wss.clients.forEach((c) => c.close())
          // Object.keys(me.users).forEach( c=>me.users[c].end() )
        }
        me = new Me()
        result.pubkey = null

        break

      case 'dispute':
        var ch = await me.getChannel(
          K.hubs.find((m) => m.id == p.partner).pubkey,
          p.asset
        )
        await ch.d.startDispute(p.profitable)

        result.confirm = 'Started a Dispute'
        break

      case 'send':
        // TODO: support batch sends
        await me.payChannel(p.outward)
        break

      case 'rebalance':
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
              var u = await User.findOne({
                where: {
                  pubkey: userId
                }
              })

              if (u) {
                userId = u.id
              }
            } else {
              var userId = parseInt(to[0])

              var u = await User.findById(userId)

              if (!u) {
                result.alert =
                  'User with short ID ' + userId + " doesn't exist."
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
            break
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
              react({confirm: 'Onchain rebalance tx sent'})
            } else {
              react({
                alert:
                  'Failed to obtain withdrawal. Try later or start a dispute.'
              })
            }
          }, 3000)
        } else if (outs.length > 0) {
          me.batch.push(['withdrawFrom', asset, ins])
          me.batch.push(['depositTo', asset, outs])
        }

        if (me.batch.length == 0) {
          react({alert: 'Nothing to send onchain'})
        } else {
          react({confirm: 'Wait for tx to be added to blockchain'})
        }

        return false

        break

      case 'createAsset':
        me.batch.push([
          'createAsset',
          [p.ticker, parseInt(p.amount), p.name, p.desc]
        ])
        react({confirm: 'Added to batch'})

        break
      case 'createHub':
        react({confirm: 'Added to batch'})
        break

      case 'createOrder':
        p.order.amount = parseInt(p.order.amount)

        var asset = parseInt(p.asset)
        if (p.order.amount > 0) {
          if (p.order.amount > me.record.asset(asset) + p.request_amount) {
            // more than you can theoretically have even after withdrawal
            react({alert: 'Not enough funds to trade this amount'})
          } else {
            me.batch.push([
              'createOrder',
              [
                asset,
                parseInt(parseFloat(p.order.amount) * 100),
                parseInt(p.order.buyAssetId),
                parseInt(parseFloat(p.order.rate) * 1000000)
              ]
            ])
          }
        }
        react({confirm: 'Added to batch'})

        break
      case 'cancelOrder':
        me.batch.push(['cancelOrder', [p.id]])
        react({confirm: 'Added to batch'})

        break
      case 'getinfo':
        result.address = me.address

        break
      case 'invoices':
        result.ack = await Payment.findAll({
          where: {
            type: 'del',
            status: 'ack',
            is_inward: true
          }
        })

        await Payment.update(
          {
            status: 'processed'
          },
          {
            where: {
              type: 'del',
              status: 'ack',
              is_inward: true
            }
          }
        )

        break
      case 'testnet':
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

        result.confirm = 'Testnet action triggered'

        break

      case 'hardfork':
        //security: ensure it's not RCE and put extra safeguards
        //eval(p.hardfork)
        result.confirm = 'Executed'
        break

      case 'setLimits':
        var m = K.hubs.find((m) => m.id == p.partner)

        var ch = await me.getChannel(m.pubkey, p.asset)

        ch.d.soft_limit = parseInt(p.limits[0]) * 100
        ch.d.hard_limit = parseInt(p.limits[1]) * 100
        await ch.d.save()

        me.send(
          m,
          'setLimits',
          me.envelope(
            methodMap('setLimits'),
            ch.d.asset,
            ch.d.soft_limit,
            ch.d.hard_limit
          )
        )

        result.confirm = 'The hub has been notified about new credit limits'

        break

      case 'propose':
        if (p[0].length <= 1) throw 'Rationale is required'

        if (p[2]) {
          // for some reason execSync throws but gives result
          try {
            // exclude all non-JS files for now
            p[2] = child_process.execSync(
              'diff  -Naur --exclude=*{.cache,data,dist,Failsafe.app,node_modules,private,spec,.git}  ../8001 . '
            )
          } catch (err) {
            p[2] = err.stdout
          }
        }

        me.batch.push(['propose', p])
        result.confirm = 'Proposed'
        break

      case 'vote':
        me.batch.push(['vote', [p.id, p.approval, p.rationale]])
        result.confirm = 'Voted'

        break

      case 'sync':
        result.confirm = 'Syncing the chain...'
        sync()

        break

      // Successor of Secure Login, returns signed origin
      case 'login':
        ws.send(
          JSON.stringify({
            result: toHex(
              nacl.sign(Buffer.from(json.proxyOrigin), me.id.secretKey)
            )
          })
        )
        return false
        break
    }

    // http or websocket?
    if (ws.end) {
      ws.end(JSON.stringify(result))
    } else {
      /*ws.send(
        JSON.stringify({
          result: Object.assign(result, cached_result)
        })
      )*/
      react(result)
    }
  } else {
    // the request is not authorized with auth_code - just send public explorer data
    ws.send(
      JSON.stringify({
        result: cached_result
      })
    )
  }
}
