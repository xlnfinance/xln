// users rarely promise funds to the hub, so there is no periodic rebalance
// 1. users can do manual rebalance, e.g. tranfering funds from old to better hub
// 2. used for direct settlement and large transfers
const withdraw = require('../offchain/withdraw')

module.exports = async (p) => {
  let asset = parseInt(p.asset)

  let withdrawFrom = []
  let depositTo = []
  let disputes = []

  // withdrawing promises
  let await_all = []

  let balance = me.record.asset(asset)

  // do something with every channel
  for (let index in p.chActions) {
    let action = p.chActions[index]

    let ch = await me.getChannel(fromHex(action.partnerId), asset)

    if (action.startDispute) {
      disputes.push(await ch.d.getDispute())
    }

    if (action.depositAmount > 0) {
      if (action.withdrawAmount > 0) {
        react({
          alert: "It's pointless to deposit and withdraw at the same time"
        })
        return
      }

      balance -= action.depositAmount

      depositTo.push([action.depositAmount, me.record.id, ch.partner, 0])
    }

    if (action.withdrawAmount == 0) {
      continue
    }

    if (action.withdrawAmount > ch.insured) {
      react({alert: 'More than you can withdraw from insured'})
      return
    }

    // waiting for the response
    await_all.push(withdraw(ch, action.withdrawAmount))
  }

  // await withdrawal proofs from all parties, or get timed out
  await_all = await Promise.all(await_all)

  // did any fail? If so, cancel entire operation
  let failed_ch = await_all.find((ch) => ch.d.withdrawal_sig == null)
  if (failed_ch) {
    react({
      alert:
        'Failed to get withdrawal from: ' +
        failed_ch.hub.handle +
        '. Try later or start a dispute.'
    })
    return
  }

  // otherwise, proceed and add them
  for (let ch of await_all) {
    balance += ch.d.withdrawal_amount

    // if there is anything to withdraw the user is already registred
    withdrawFrom.push([ch.d.withdrawal_amount, ch.partner, ch.d.withdrawal_sig])
  }

  // external deposits are everything else other than you@anyhub
  for (o of p.externalDeposits) {
    // split by @
    if (o.to.length > 0) {
      let to = o.to
      let userId

      // looks like a pubkey
      if (to.length == 64) {
        userId = Buffer.from(to, 'hex')

        // maybe this pubkey is already registred?
        let u = await User.idOrKey(userId)

        if (u.id) {
          userId = u.id
        }
      } else {
        // looks like numerical ID
        userId = parseInt(to)

        let u = await User.idOrKey(userId)

        if (!u) {
          result.alert = 'User with short ID ' + userId + " doesn't exist."
          break
        }
      }

      //if (o.amount.indexOf('.') == -1) o.amount += '.00'
      //.replace(/[^0-9]/g, '')

      let amount = parseInt(o.depositAmount)

      let withPartner = 0
      // @onchain or @0 mean onchain balance
      if (o.hub && o.hub != 'onchain' && o.hub != '0') {
        // find a hub by its handle or id
        let h = K.hubs.find((h) => h.handle == o.hub || h.id == o.hub)
        if (h) {
          withPartner = h.id
        } else {
          react({alert: 'No such hub'})
          return
        }
      }

      if (amount > 0) {
        balance -= amount

        depositTo.push([
          amount,
          userId,
          withPartner,
          o.invoice ? Buffer.from(o.invoice, 'hex') : 0
        ])
      }
    }
  }

  if (balance < 0) {
    react({alert: 'Your final balance will become negative: not enough funds.'})
    return
  }

  if (disputes.length + withdrawFrom.length + depositTo.length == 0) {
    react({alert: 'Nothing to send onchain'})
    return
  } else {
    // finally flushing all of them to pending batch
    me.batch.push(['withdrawFrom', asset, withdrawFrom])
    me.batch.push(['depositTo', asset, depositTo])
    me.batch.push(['disputeWith', asset, disputes])

    react({confirm: 'Onchain tx added.'})
  }
}
