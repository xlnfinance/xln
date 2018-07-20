module.exports = async (args) => {
  // why would we be asked to add tx to block?
  if (!me.my_validator) return false

  //if (me.my_validator == nextValidator(true)) {
  args.map((tx) => {
    me.mempool.push(tx)
  })
  //} else {
  //  me.send(nextValidator(true), 'tx', msg)
  //}
}
