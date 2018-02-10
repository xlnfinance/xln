// Internal RPC serves requests made by the wallet (the user's browser) or by the merchant app

module.exports = async (ws, msg) => {
  var result = {}
 
  var json = parse(bin(msg).toString())

  // prevents all kinds of CSRF and DNS rebinding
  // strong coupling between the console and the browser client

  if (json.auth_code == PK.auth_code) {

    if (ws.send) {
      // browser session
      me.browser = ws     
    }

    var p = json.params

    switch (json.method) {
      case 'sync':
        result.confirm = 'Syncing the chain...'
        sync()

        break
      case 'load':
        if (p.username) {
          var seed = await derive(p.username, p.pw)
          await me.init(p.username, seed)
          await me.start()

          result.confirm = 'Welcome!'
        }

        break
      case 'logout':
        me.id = false
        me.intervals.map(clearInterval)
        result.pubkey = false

        break

      case 'takeEverything':

        var ch = await me.channel(1)
        // post last available signed delta
        await me.broadcast('rebalanceUser', r([ 0, [ch.delta_record.sig ? ch.delta_record.sig : 1], [] ]))
        result.confirm = 'Started a dispute onchain. Please wait a delay period to get your money back.'
        break

      case 'send':

        var hubId = parseInt(p.hubId)

        var amount = parseInt(p.amount)

        if (p.userId.length == 64) {
          var mediate_to = Buffer.from(p.userId, 'hex')
        } else {
          var mediate_to = await User.findById(parseInt(p.userId))
          if (mediate_to) {
            mediate_to = mediate_to.pubkey
          } else {
            result.alert = 'This user ID is not found'
            break
          }
        }



        var [status, error] = await me.payChannel({
          counterparty: hubId,
          amount: amount, 
          mediate_to: mediate_to,
          return_to: (obj)=>{
            l("Returning now")
            ws.send ? ws.send(JSON.stringify({
              result: obj,
              id: json.id
            })) : ws.end(JSON.stringify(obj))
          },
          invoice: Buffer.from(p.invoice, 'hex')
        })

        if (error) {
          result.alert = error
        } else {
          return false
        }

        break

      case 'rebalanceUser':
        // contacting hubs and collecting instant withdrawals ins

        var outs = []
        for (o of p.outs) {
          // split by @
          if (o.to.length > 0) {
            var to = o.to.split('@')

            var hubId = to[1] ? parseInt(to[1]) : 0

            if (to[0].length == 64) {
              var userId = Buffer.from(to[0], 'hex')

              // maybe this pubkey is already registred?
              var u = await User.findOne({where: {
                pubkey: userId
              }})

              if (u) {
                userId = u.id
              }
            } else {
              var userId = parseInt(to[0])

              var u = await User.findById(userId)

              if (!u) {
                result.alert = 'User with short ID ' + userId + " doesn't exist."
              }
            }

            if (o.amount.indexOf('.') == -1) o.amount += '.00'

            var amount = parseInt(o.amount.replace(/[^0-9]/g, ''))

            if (amount > 0) {
              outs.push([userId, hubId, amount])
            }
          }
        }

        if (!result.alert) {
          var encoded = r([0, p.ins, outs])

          result.confirm = await me.broadcast('rebalanceUser', encoded)
        }

        break
      case 'faucet':
        me.send(K.members[0], 'faucet', bin(me.id.publicKey))
        result.confirm = 'Faucet triggered. Check your wallet!'

        break




      case 'invoice':
        if (p.invoice) {
          // deep clone
          var result = Object.assign({}, invoices[p.invoice])

          // prevent race condition attack
          if (invoices[p.invoice].status == 'paid') { invoices[p.invoice].status = 'archive' }
        } else {

          var secret = crypto.randomBytes(32)
          var invoice = toHex(sha3(secret))

          invoices[invoice] = {
            secret: secret,
            amount: parseInt(p.amount),
            status: 'pending'
          }

          me.record = await me.byKey()

          var hubId = 1

          result.new_invoice = [
            invoices[invoice].amount, 
            me.record ? me.record.id : toHex(me.id.publicKey),
            hubId,
            invoice].join('_')

          result.confirm = 'Invoice Created'
        }
      break


      case 'propose':
        result.confirm = await me.broadcast('propose', p)
        break

      case 'vote':
        result.confirm = await me.broadcast(p.approve ? 'voteApprove' : 'voteDeny', r([p.id, p.rationale]))

        break

      // Extra features: Failsafe Login
      case 'login':
        result.token = toHex(nacl.sign(json.proxyOrigin, me.id.secretKey))
        break
    }
    
    // is HTTP response or websocket?
    if (ws.end) {
      ws.end(JSON.stringify(result))
    } else {
      react(result, json.id)
    }

  } else {
    ws.send(JSON.stringify({
      result: Object.assign(result, cached_result),
      id: json.id
    }))
  }
}
