module.exports = (ws, msg) => {
  // uws gives ArrayBuffer, we create a view
  let msgb = bin(msg)

  // count total bandwidth
  me.metrics.bandwidth.current += msgb.length

  // sanity checks 10mb
  if (msgb.length > 50000000) {
    l(`too long input ${msgb.length}`)
    return false
  }

  // we have no control over potentially malicious user input, so ignore all errors
  try {
    let args = r(msgb.slice(1))
    let inputType = methodMap(msgb[0])

    switch (inputType) {
      case 'JSON':
        return require('./with_channel')(ws, args)

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
        return me.processChain(args)
      case 'sync':
        return require('./sync')(ws, args)

      case 'textMessage':
        react({confirm: args[0].toString()})
        return

      default:
        return false
    }
  } catch (e) {
    l('External RPC error', e)
  }
}
