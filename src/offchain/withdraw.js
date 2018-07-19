// make a request to ask for (mutual) withdrawal proof from a specific node
// the promise returns either a valid proof or times out
module.exports = async function(opts) {
  // send a request

  me.send(
    opts.withPartner,
    'requestWithdrawFrom',
    me.envelope(opts.amount, opts.asset)
  )

  let fallback = setTimeout(() => {}, 5000)
}
