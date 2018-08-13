module.exports = async (s, tr) => {
  // onchain exchange to sell an asset for another one.
  let [assetId, amount, buyAssetId, raw_rate] = tr[1].map(readInt)
  const round = Math.round
  const rate = raw_rate / 1000000 // convert back from integer

  const direct_order = assetId > buyAssetId

  const sellerOwns = userAsset(s.signer, assetId)

  if (sellerOwns < amount) {
    l('Trying to sell more then signer has')
    return
  }

  userAsset(s.signer, assetId, -amount)

  const order = Order.build({
    amount: amount,
    rate: rate,
    userId: s.signer.id,
    assetId: assetId,
    buyAssetId: buyAssetId
  })

  // now let's try orders with same rate or better
  const orders = await Order.findAll({
    where: {
      assetId: buyAssetId,
      buyAssetId: assetId,
      rate: {
        // depending on which side of pair we sell, different order
        [direct_order ? Op.gte : Op.lte]: rate
      }
    },
    limit: 500,
    order: [['rate', direct_order ? 'desc' : 'asc']]
  })

  for (const their of orders) {
    let they_buy
    let we_buy
    if (direct_order) {
      they_buy = round(their.amount / their.rate)
      we_buy = round(order.amount * their.rate)
    } else {
      they_buy = round(their.amount * their.rate)
      we_buy = round(order.amount / their.rate)
    }

    //l('Suitable order', we_buy, they_buy, their)

    const seller = await getUserByidOrKey(their.userId)
    if (we_buy > their.amount) {
      // close their order. give seller what they wanted
      userAsset(seller, their.buyAssetId, they_buy)
      userAsset(s.signer, order.buyAssetId, their.amount)

      their.amount = 0
      order.amount -= they_buy
    } else {
      // close our order
      userAsset(seller, their.buyAssetId, order.amount)
      userAsset(s.signer, order.buyAssetId, we_buy)

      their.amount -= we_buy
      order.amount = 0
    }

    if (their.amount == 0) {
      // did our order fullfil them entirely?
      await their.destroy()
    } else {
      await their.save()
    }
    //await seller.save()
  }

  if (order.amount > 0) {
    // is new order still not fullfilled? keep in orderbook
    await order.save()
  } else {
    // doesn't even exist yet
  }

  s.parsed_tx.events.push(['createOrder', assetId, amount, buyAssetId, rate])
}
