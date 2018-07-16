module.exports = (ws, msg) => {
  // uws gives ArrayBuffer, we create a view
  let msgb = bin(msg)

  // sanity checks 10mb
  if (msgb.length > 50000000) {
    l(`too long input ${msgb.length}`)
    return false
  }

  let args = r(msgb.slice(1))
  let inputType = methodMap(msgb[0])

  switch (inputType) {
    case 'auth':
      return require('./auth')(ws, args)
    case 'tx':
      return require('./tx')(args)
    case 'propose':
      return require('./propose')(args)
    case 'prevote':
      return require('./prevote_precommit')(inputType, args)
    case 'precommit':
      return require('./prevote_precommit')(inputType, args)
    case 'chain':
      return require('../onchain/chain')(args)
    case 'sync':
      return require('./sync')(ws, args)
    case 'setLimits':
      return require('./set_limits')(args)
    case 'requestWithdrawFrom':
      return require('./request_withdraw_from')(args)
    case 'withdrawFrom':
      return require('./withdraw_from')(args)
    case 'update':
      return require('./update')(args)
    case 'testnet':
      return require('./testnet')(args)
    default:
      return false
  }
}
