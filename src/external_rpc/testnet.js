module.exports = async (args) => {
  let action = readInt(args[0])

  if (action == 1) {
    let asset = readInt(args[1])
    let amount = readInt(args[2])
    me.payChannel({
      address: args[3],
      amount: amount,
      invoice: Buffer.alloc(1),
      asset: asset
    })
  }
}
