// signs and broadcasts
module.exports = async function(opts) {
  if (PK.pending_batch) {
    return l('Only 1 tx is supported')
  }
  // TODO: make batch persistent on disk

  let estimated = await me.batch_estimate(opts)

  if (!estimated) return

  if (me.my_validator && me.my_validator == nextValidator(true)) {
    me.mempool.push(estimated.signed_batch)
  } else {
    me.send(nextValidator(true), 'tx', r([estimated.signed_batch]))
  }

  // saving locally to ensure it is added, and rebroadcast if needed
  PK.pending_batch = toHex(estimated.signed_batch)
  me.batch = []
}
