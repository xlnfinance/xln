module.exports = async (inputType, args) => {
  let [pubkey, sig, body] = args
  let [method, header] = r(body)
  let m = Members.find((f) => f.block_pubkey.equals(pubkey))

  if (me.status != inputType || !m) {
    return //l(`${me.status} not ${inputType}`)
  }

  if (header.length < 5) {
    return //l(`${m.id} voted nil`)
  }

  if (!me.proposed_block.header) {
    //l('We have no block')
    return
  }

  if (
    ec.verify(r([methodMap(inputType), me.proposed_block.header]), sig, pubkey)
  ) {
    m[inputType] = sig
    //l(`Received ${inputType} from ${m.id}`)
  } else {
    l(
      `This ${inputType} by ${m.id} doesn't work for our block ${toHex(
        me.proposed_block.header
      )}`
    )
  }
}
