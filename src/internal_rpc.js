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
          me.wss.clients.forEach((c) => c.close())
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
        if (p.pay_invoice) {
          var inv = p.pay_invoice.split('_')
          var parsed = {}

          parsed.amount = inv[0]
          parsed.invoice = inv[1]
          parsed.box_pubkey = inv[2]
          parsed.pubkey = inv[3]
          parsed.partners = []

          for (var i = 4; i < inv.length; i++) {
            parsed.partners.push(parseInt(inv[i]))
          }

          parsed.trimmedId =
            inv[2].length == 64 ? inv[2].substr(0, 10) + '...' : inv[2]

          parsed.fee = Math.round(parseInt(parsed.amount) * 0.001)
        }

        if (p.dry_run) {
          react({parsed_invoice: parsed})
          return false
        }

        if (parsed.pubkey.length == 64) {
          var destination = Buffer.from(parsed.pubkey, 'hex')
        } else {
          var destination = await User.findById(parseInt(parsed.pubkey))
          if (destination) {
            destination = destination.pubkey
          } else {
            result.alert = 'This user ID is not found'
            break
          }
        }

        var secret = crypto.randomBytes(32) // no need to store
        var unlocker_nonce = crypto.randomBytes(24)

        var box_pubkey = Buffer.from(parsed.box_pubkey, 'hex')
        var invoice = Buffer.from(parsed.invoice, 'hex')

        var hash = sha3(secret)

        var amount = parseInt(parsed.amount)

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

        var ch = await me.getChannel(Members[0].pubkey)
        l('adding payment')
        await ch.d.save()

        await ch.d.createPayment({
          status: 'await',
          is_inward: false,

          amount: amount,
          hash: hash,
          exp: K.usable_blocks + 10,

          unlocker: unlocker,
          destination: destination
        })

        await me.payChannel(Members[0].pubkey)

        result.confirm = 'Payment sent...'

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

              l('Rebalancing ', [ins, outs])

              await me.broadcast('rebalance', r([[], ins, outs]))
              react({confirm: 'On-chain rebalance tx sent'})
            } else {
              react({
                alert:
                  'Failed to obtain withdrawal. Try later or start a dispute.'
              })
            }
          }, 3000)
        } else if (outs.length > 0) {
          await me.broadcast('rebalance', r([[], ins, outs]))
          react({confirm: 'Rebalanced'})
        } else {
          react({alert: 'No action specified'})
        }

        return false

        break

      case 'testnet':
        me.send(
          Members.find((m) => m.id == p.partner),
          'testnet',
          concat(bin([p.action]), me.pubkey)
        )

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

      // creates and checks status of invoice
      case 'invoice':
        if (p.invoice) {
          // deep clone
          var result = Object.assign({}, invoices[p.invoice])

          // prevent race condition attack
          if (invoices[p.invoice].status == 'paid') {
            invoices[p.invoice].status = 'archive'
          }
        } else if (p.amount) {
          var amount = parseInt(p.amount)

          var secret = crypto.randomBytes(32)
          var invoice = sha3(secret)

          me.record = await me.byKey()

          // format: bin(me.box.publicKey)

          // we attempt to sort members by receivable to increase chance of payment success

          // todo: all channels or particular?
          var offered_partners = (await me.channels())
            .sort((a, b) => b.they_payable - a.they_payable)
            .filter((a) => a.they_payable >= amount)
            .map((a) => a.partner)
            .join('_')

          var rawInvoice = [
            amount,
            toHex(invoice),
            toHex(me.box.publicKey),
            me.record ? me.record.id : toHex(me.pubkey), // onchain allowed?
            offered_partners
          ].join('_')

          invoices[toHex(invoice)] = {
            secret: secret,
            amount: parseInt(p.amount),
            extra: p.extra,
            status: 'pending',
            invoice: rawInvoice
          }

          result.new_invoice = rawInvoice

          result.confirm = 'Invoice Created'
        }
        break

      case 'propose':
        result.confirm = await me.broadcast('propose', p)
        break

      case 'vote':
        result.confirm = await me.broadcast(
          'vote',
          r([p.id, p.approval, p.rationale])
        )

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
