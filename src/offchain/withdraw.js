// make a request to ask for (mutual) withdrawal proof from partner
// the promise returns either a valid proof or error
module.exports = async function(ch, subch, amount) {
  // reset values
  //ch.d.withdraw_sig = null
  //ch.d.withdraw_amount = 0

  l('Withdrawal request for ' + amount)

  me.sendJSON(ch.d.partnerId, 'requestWithdrawal', {
    amount: amount,
    asset: subch.asset
  })

  return new Promise(async (resolve) => {
    let timeout = setTimeout(() => {
      // if the partner is offline
      delete me.withdrawalRequests[subch.id]
      resolve(ch)
    }, 5000)
    me.withdrawalRequests[subch.id] = (result) => {
      clearInterval(timeout)
      delete me.withdrawalRequests[subch.id]
      resolve(result)
    }
  })
}
