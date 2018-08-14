module.exports = async (s, args) => {
  const [raw_ticker, raw_amount, raw_name, raw_desc] = args
  let amount = readInt(raw_amount)
  const ticker = raw_ticker.toString().replace(/[^a-zA-Z0-9]/g, '') // from buffer to unicode, sanitize

  if (ticker.length < 3) {
    l('Too short ticker')
    return
  }

  const exists = await Asset.findOne({where: {ticker: ticker}})
  if (exists) {
    if (exists.issuerId == s.signer.id) {
      //minting new tokens to issuer's onchain balance
      exists.total_supply += amount
      userAsset(s.signer, exists.id, amount)
      await exists.save()

      s.parsed_tx.events.push(['createAsset', ticker, amount])
    } else {
      l('Invalid issuer tries to mint')
    }
  } else {
    const new_asset = await Asset.create({
      issuerId: s.signer.id,
      ticker: ticker,
      total_supply: amount,

      name: raw_name ? raw_name.toString() : '',
      desc: raw_desc ? raw_desc.toString() : ''
    })

    K.assets_created++

    userAsset(s.signer, new_asset.id, amount)
    s.parsed_tx.events.push([
      'createAsset',
      new_asset.ticker,
      new_asset.total_supply
    ])
  }
}
