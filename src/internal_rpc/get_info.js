module.exports = () => {
  // returns generic info about current account and the network
  let result = {
    address: me.getAddress(),
    assets: cached_result.assets //await Asset.findAll()
  }

  return result
}
