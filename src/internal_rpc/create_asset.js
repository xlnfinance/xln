module.exports = (args) => {
  let amount = parseInt(args.amount)

  // 256**6, buffer max size
  if (amount >= 281474976710000) return

  me.batchAdd('createAsset', [args.ticker, amount, args.name, args.desc])
}
