module.exports = (p) => {
  let amount = parseInt(p.order.amount)
  let asset = parseInt(p.asset)
  if (amount > 0) {
    if (amount > userAsset(me.record, asset) + p.request_amount) {
      // more than you can theoretically have even after withdrawal
      react({alert: 'Not enough funds to trade this amount', force: true})
    } else {
      me.batchAdd('createOrder', [
        asset,
        parseInt(parseFloat(amount) * 100),
        parseInt(p.order.buyAssetId),
        parseInt(parseFloat(p.order.rate) * 1000000)
      ])
    }
  }
  return {}
}
