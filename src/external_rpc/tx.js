module.exports = async (args) => {
  // why would we be asked to add tx to block?
  if (!me.my_validator) return false

  //if (me.my_validator == me.next_validator(1)) {
  args.map((tx) => {
    me.mempool.push(tx)
  })
  //} else {
  //  me.send(me.next_validator(1), 'tx', msg)
  //}
}
