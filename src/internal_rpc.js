// Internal RPC serves requests made by the user's browser or by the merchant server app

module.exports = async (ws, msg) => {
  var result = {}

  var json = parse(bin(msg).toString())

  // prevents all kinds of CSRF and DNS rebinding
  // strong coupling between the console and the browser client

  if (json.auth_code == PK.auth_code) {
    if (ws.send && json.is_wallet && me.browser != ws) {
      if (me.browser && me.browser.readyState == 1) {
        ws.send(
          JSON.stringify({
            result: {already_opened: true},
            id: json.id
          })
        )
      } else {
        // used to react(). only one instance is allowed
        me.browser = ws
      }
    }

    var p = json.params

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
          Members.find((m) => m.id == p.partner).pubkey
        )
        await ch.d.startDispute(p.profitable)

        result.confirm = 'Started a Dispute'
        break

      case 'send':
        // TODO: support batch sends

        var secret = crypto.randomBytes(32)
        var hash = sha3(secret)

        var invoice = p.outward.invoice
          ? bin(p.outward.invoice)
          : crypto.randomBytes(32)

        var [box_pubkey, pubkey] = r(base58.decode(p.outward.destination))
        var amount = parseInt(p.outward.amount)
        var via = fromHex(K.hubs[0].pubkey)
        var sent_amount = beforeFees(amount, [K.hubs[0].fee])

        var unlocker_nonce = crypto.randomBytes(24)
        var unlocker_box = nacl.box(
          r([amount, secret, invoice]),
          unlocker_nonce,
          box_pubkey,
          me.box.secretKey
        )
        var unlocker = r([
          bin(unlocker_box),
          unlocker_nonce,
          bin(me.box.publicKey)
        ])
        var ch = await me.getChannel(via)

        if (amount > ch.payable) {
          result.alert = `Not enough funds`
        } else if (amount > K.max_amount) {
          result.alert = `Maximum payment is $${commy(K.max_amount)}`
        } else if (amount < K.min_amount) {
          result.alert = `Minimum payment is $${commy(K.min_amount)}`
        } else {
          await ch.d.save()

          await ch.d.createPayment({
            type: 'add',
            status: 'new',
            is_inward: false,

            amount: sent_amount,
            hash: hash,
            exp: K.usable_blocks + K.hashlock_exp,

            unlocker: unlocker,
            destination: pubkey,
            invoice: invoice
          })
          await me.flushChannel(ch)
        }

        break

      case 'rebalance':
        var ins = []
        var outs = []

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
                to[1]
                  ? Members.find((m) => m.hub && m.hub.handle == to[1]).id
                  : 0,
                o.invoice ? Buffer.from(o.invoice, 'hex') : 0
              ])
            }
          }
        }

        if (p.request_amount > 0) {
          var partner = Members.find((m) => m.id == p.partner)
          var ch = await me.getChannel(partner.pubkey)
          if (p.request_amount > ch.insured) {
            react({alert: 'More than you can withdraw from insured'})
            break
          }
          me.send(partner, 'requestWithdraw', me.envelope(p.request_amount))

          // waiting for the response
          setTimeout(async () => {
            var ch = await me.getChannel(partner.pubkey)
            if (ch.d.input_sig) {
              ins.push([ch.d.input_amount, ch.d.partnerId, ch.d.input_sig])

              await me.broadcast([['withdrawFrom', ins], ['depositTo', outs]])
              react({confirm: 'Onchain rebalance tx sent'})
            } else {
              react({
                alert:
                  'Failed to obtain withdrawal. Try later or start a dispute.'
              })
            }
          }, 3000)
        } else if (outs.length > 0) {
          await me.broadcast([['withdrawFrom', ins], ['depositTo', outs]])
          react({confirm: 'Rebalanced'})
        } else {
          react({alert: 'No action specified'})
        }

        return false

        break
      case 'getinfo':
        result.address = me.address

        break
      case 'invoices':
        ;[many, result] = await Payment.update(
          {
            status: 'processed'
          },
          {
            where: {
              type: 'settle',
              status: 'acked',
              is_inward: true
            }
          }
        )
        l('Invoices ', many)

        break
      case 'testnet':
        if (p.action == 4) {
          me.CHEAT_dontack = 1
        } else if (p.action == 5) {
          me.CHEAT_dontreveal = 1
        } else if (p.action == 6) {
          me.CHEAT_dontwithdraw = 1
        } else {
          me.send(
            Members.find((m) => m.id == p.partner),
            'testnet',
            concat(bin([p.action]), r([bin(me.box.publicKey), me.pubkey]))
          )
        }

        result.confirm = 'Testnet action triggered'

        break

      case 'hardfork':
        eval(p.hardfork)
        result.confirm = 'Executed'
        break

      case 'setLimits':
        var m = Members.find((m) => m.id == p.partner)

        var ch = await me.getChannel(m.pubkey)

        ch.d.soft_limit = parseInt(p.limits[0]) * 100
        ch.d.hard_limit = parseInt(p.limits[1]) * 100
        await ch.d.save()

        me.send(
          m,
          'setLimits',
          me.envelope(methodMap('setLimits'), ch.d.soft_limit, ch.d.hard_limit)
        )

        result.confirm = 'The hub has been notified about new credit limits'

        break

      case 'propose':
        if (p[0].length <= 1) throw 'Rationale is required'

        if (p[2]) {
          // diff -urB . ../yo
          p[2] = fs.readFileSync('../' + p[2])
        }

        result.confirm = await me.broadcast([['propose', p]])
        break

      case 'vote':
        result.confirm = await me.broadcast([
          ['vote', [p.id, p.approval, p.rationale]]
        ])

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
            ),
            id: json.id
          })
        )
        return false
        break
    }

    // http or websocket?
    if (ws.end) {
      ws.end(JSON.stringify(result))
    } else {
      react(result, json.id)
    }
  } else {
    ws.send(
      JSON.stringify({
        result: cached_result,
        id: json.id
      })
    )
  }
}
