// Internal RPC serves requests made by the user's browser or by the merchant server app

module.exports = async (ws, json) => {
  var result = {}

  // prevents all kinds of CSRF and DNS rebinding
  // strong coupling between the console and the browser client
  if (json.auth_code == PK.auth_code || ws == 'admin') {
    if (ws.send && json.is_wallet && me.browser != ws) {
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
        await me.payChannel(p)
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
              var u = await User.idOrKey(userId)

              if (u.id) {
                userId = u.id
              }
            } else {
              var userId = parseInt(to[0])

              var u = await User.idOrKey(userId)

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
          } else {
            react({confirm: "Requested withdrawals..."})
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
                alert:
                  'Failed to obtain withdrawal. Try later or start a dispute.'
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

      case 'propose':
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


      // commonly called by merchant app on the same server
      case 'receivedAndFailed':
        await me.syncdb()

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
            {
              processed: true
            },
            {
              where: {
                type: 'del',
                status: 'ack',
                [Op.or]: [{is_inward: true}, {is_inward: false, secret: null}]
              }
            }
          )
        }


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

      // sets credit limits to a hub
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
            map('setLimits'),
            ch.d.asset,
            ch.d.soft_limit,
            ch.d.hard_limit
          )
        )

        result.confirm = 'Credit limits updated'
        break

    }

    // http or websocket?
    if (ws.end) {
      ws.end(JSON.stringify(result))
    } else if (ws =='admin'){
      return result

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
    if (ws.end) {
      ws.end(JSON.stringify(result))
    } else {
      ws.send(
        JSON.stringify({
          result: cached_result
        })
      )
    }
  }
}
