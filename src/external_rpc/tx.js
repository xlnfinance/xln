module.exports = async (args) => {
  // why would we be asked to add tx to block?
  if (!me.my_member) return false

  //if (me.my_member == me.next_member(1)) {
  args.map((tx) => {
    me.mempool.push(tx)
  })
  //} else {
  //  me.send(me.next_member(1), 'tx', msg)
  //}
}
