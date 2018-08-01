// make a request to ask for (mutual) withdrawal proof from partner
// the promise returns either a valid proof or error
module.exports = async function(ch, amount) {
  me.send(
    ch.d.partnerId,
    'requestWithdrawFrom',
    me.envelope(amount, ch.d.asset)
  )

  return new Promise(async (resolve) => {
    let timeout = setTimeout(() => {
      // if the partner is offline
      delete me.withdrawalRequests[ch]
      resolve('timeout')
    }, 3000)
    me.withdrawalRequests[ch] = (result) => {
      clearInterval(timeout)
      delete me.withdrawalRequests[ch]
      resolve(result)
    }
  })
}
