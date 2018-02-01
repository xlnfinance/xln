module.exports = async (ws, msg) => {
  var result = {}

  var json = JSON.parse(bin(msg).toString())
  var p = json.params

  // prevents all kinds of CSRF and DNS rebinding
  // strong coupling between the console and the browser client

  if (json.auth_code == auth_code) {
    me.browser = ws

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
        await me.broadcast('settleUser', r([ 0, [ch.delta_record.sig ? ch.delta_record.sig : 1], [] ]))
        result.confirm = 'Started a dispute onchain. Please wait a delay period to get your money back.'
        break

      case 'send':

        var hubId = 1

        var amount = parseInt(parseFloat(p.off_amount) * 100)

        if (p.off_to.length == 64) {
          var mediate_to = Buffer.from(p.off_to, 'hex')
        } else {
          var mediate_to = await User.findById(parseInt(p.off_to))
          if (mediate_to) {
            mediate_to = mediate_to.pubkey
          } else {
            result.alert = 'This user ID is not found'
            break
          }
        }

        var [status, error] = await me.payChannel(hubId, amount, mediate_to)
        if (error) {
          result.alert = error
        } else {
          result.confirm = `Sent \$${p.off_amount} to ${p.off_to}!`
        }

        break

      case 'settleUser':

        // settle fsd ins outs

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

          result.confirm = await me.broadcast('settleUser', encoded)
        }

        break
      case 'faucet':
        me.sendMember('faucet', bin(me.id.publicKey), 0)
        result.confirm = 'Faucet triggered. Check your wallet!'

        break
      case 'pay':
        l('paying ', json.params)

        await me.payChannel(1,
          parseInt(json.params.amount),
          Buffer.from(json.params.recipient, 'hex'),
          Buffer.from(json.params.invoice, 'hex')
          )
        result.status = 'paid'
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

    react(result, json.id)
  } else {
    ws.send(JSON.stringify({
      result: Object.assign(result, cached_result),
      id: json.id
    }))
  }
}
