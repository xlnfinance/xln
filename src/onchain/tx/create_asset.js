module.exports = async (global_state, tr, signer) => {
  const [raw_ticker, raw_amount] = tr[1]
  let amount = readInt(raw_amount)
  const ticker = raw_ticker.toString().replace(/[^a-zA-Z0-9]/g, '') // from buffer to unicode, sanitize

  if (ticker.length < 3) {
    l('Too short ticker')
    return
  }

  const exists = await Asset.findOne({where: {ticker: ticker}})
  if (exists) {
    if (exists.issuerId == signer.id) {
      //minting new tokens to issuer's onchain balance
      exists.total_supply += amount
      userAsset(signer, exists.id, amount)
      await exists.save()

      global_state.events.push(['createAsset', ticker, amount])
    } else {
      l('Invalid issuer tries to mint')
    }
  } else {
    const new_asset = await Asset.create({
      issuerId: signer.id,
      ticker: ticker,
      total_supply: amount,

      name: tr[1][2] ? tr[1][2].toString() : '',
      desc: tr[1][3] ? tr[1][3].toString() : ''
    })

    K.assets_created++

    userAsset(signer, new_asset.id, amount)
    global_state.events.push([
      'createAsset',
      new_asset.ticker,
      new_asset.total_supply
    ])
  }
}
