module.exports = (p) => {
  let amount = parseInt(p.amount)

  // 256**6, buffer max size
  if (amount >= 281474976710000) return

  me.batch.push(['createAsset', [p.ticker, amount, p.name, p.desc]])
}
