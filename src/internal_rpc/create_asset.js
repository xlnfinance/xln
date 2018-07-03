module.exports = (p) => {
  me.batch.push(['createAsset', [p.ticker, parseInt(p.amount), p.name, p.desc]])
}
