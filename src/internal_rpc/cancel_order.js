module.exports = (args) => {
  me.batch.push(['cancelOrder', [args.id]])
}
