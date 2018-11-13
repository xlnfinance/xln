// make a request to ask for (mutual) withdrawal proof from partner
// the promise returns either a valid proof or error
module.exports = async function(ch, asset, amount) {
  // reset values
  //ch.d.withdraw_sig = null
  //ch.d.withdraw_amount = 0

  l('Withdrawal request for ' + amount)

  me.send(ch.d.partnerId, 'requestWithdrawFrom', me.envelope(amount, asset))

  return new Promise(async (resolve) => {
    let timeout = setTimeout(() => {
      // if the partner is offline
      delete me.withdrawalRequests[ch]
      resolve(ch)
    }, 5000)
    me.withdrawalRequests[ch] = (result) => {
      clearInterval(timeout)
      delete me.withdrawalRequests[ch]
      resolve(result)
    }
  })
}
