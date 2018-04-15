// External RPC processes requests to our node coming from outside world.
// Also implements validator and hub functionality

module.exports = async (ws, msg) => {
  msg = bin(msg)
  // sanity checks 10mb
  if (msg.length > 10000000) {
    l(`too long input ${(msg).length}`)
    return false
  }
  
  var inputType = inputMap(msg[0])

  // how many blocks to share at once
  var sync_limit = 1000

  msg = msg.slice(1)

  // ignore some too frequest RPC commands 
  if (['chain', 'sync', 'propose', 'prevote', 'precommit'].indexOf(inputType) == -1) l('External RPC: ' + inputType)

  if (inputType == 'auth') {
    var [pubkey, sig, body] = r(msg)

    if (ec.verify(r([methodMap('auth')]), sig, pubkey)) {
      if (pubkey.equals(me.pubkey)) return false

      // wrap in custom WebSocketClient if it is a raw ws object
      if (ws.instance) {
        me.users[pubkey] = ws
      } else {
        me.users[pubkey] = new WebSocketClient()
        me.users[pubkey].instance = ws
      }

      if (me.my_hub) {
        var ch = await me.getChannel(pubkey)
        ch.d.last_online = new Date()
        
        // testnet: instead of cloud backups hub shares latest state
        //me.send(pubkey, 'ack', me.envelope(0, ec(ch.d.getState(), me.id.secretKey)))

        if (ch.withdrawal_requested_at) {
          me.send(pubkey, 'requestWithdraw', me.envelope(ch.insured))
        }
        await ch.d.save()
      }
    } else {
      return false
    }

  // accepts array of tx
  } else if (inputType == 'tx') {
    // why would we be asked to add tx to block?
    if (!me.my_member) return false

    if (me.my_member == me.next_member(1)) {
      r(msg).map(tx=>{
        me.mempool.push(tx)
      })
    } else {
      me.send(me.next_member(1), 'tx', msg)
    }








  // another member wants a sig
  } else if (inputType == 'propose') {
    var [pubkey, sig, header, ordered_tx_body] = r(msg)

    if (me.status != 'propose') {
      return l(`${me.status} not propose`)
    }

    // ensure the proposer is the current one
    if (!me.next_member().block_pubkey.equals(pubkey)) {
      return l("You are not the current proposer")
    }

    if (!ec.verify(header, sig, pubkey)) {
      return l("Invalid proposer sig")
    }

    if (me.proposed_block.locked) {
      return l("We are still precommited to previous block.")
    }

    // no precommits means dry run
    if (!await me.processBlock([], header, ordered_tx_body)){
      return l("Invalid block header")
    }

    // consensus operations are in-memory for now
    //l("Saving proposed block")
    me.proposed_block = {
      proposer: pubkey,
      sig: sig,

      header: header,
      ordered_tx_body: ordered_tx_body
    }

  } else if (inputType == 'prevote') {
    var [pubkey, sig] = r(msg)

    if (me.status != 'prevote') {
      return l(`${me.status} not prevote`)
    }

    if (!me.proposed_block.header) {
      return false
      //l(`we don't have a block`)
    }

    var m = Members.find(f => f.block_pubkey.equals(pubkey))

    if (m && ec.verify(r([methodMap('prevote'), me.proposed_block.header]), sig, pubkey)) {
      m.prevote = sig
      //l(`Received another prevote from  ${m.id}`)
    } else {
      l("this sig doesn't work for our block")
    }


  } else if (inputType == 'precommit') {
    var [pubkey, sig] = r(msg)

    var m = Members.find(f => f.block_pubkey.equals(pubkey))

    if (me.status != 'precommit') {
      return l(`${me.status} not precommit`)
    }

    if (!me.proposed_block.header) {
      return false
      //l(`we don't have a block`)
    }

    if (m && ec.verify( r([methodMap('precommit'), me.proposed_block.header]), sig, pubkey)) {
      m.precommit = sig
      //l(`Received another precommit from  ${m.id}`)
    } else {
      l("this sig doesn't work for our block")
    }






  // testnet stuff
  } else if (inputType == 'testnet') {
    var pubkey = msg.slice(1)
    if (msg[0] == 1) {    
      await me.payChannel({
        partner: pubkey,
        amount: Math.round(Math.random() * 10000)
      })
    }

    if (msg[0] == 2) {    
      (await me.getChannel(pubkey)).d.startDispute()
    }

    if (msg[0] == 3) {    
      (await me.getChannel(pubkey)).d.startDispute(true)
    }





  // sync requests latest blocks, chain returns chain
  } else if (inputType == 'chain') {
    var chain = r(msg)

    for (var block of chain) {
      await me.processBlock(block[0], block[1], block[2])
    }

    // dirty hack to not backup k.json until all blocks are synced
    if (chain.length == sync_limit) {
      sync()
    } else {
      fs.writeFileSync('data/k.json', stringify(K))
    }
  } else if (inputType == 'sync') {
    var last = await Block.findOne({where: {
      prev_hash: msg
    }})

    if (last) {
      //l('Sharing blocks since ' + last.id)

      var blocks = await Block.findAll({
        where: {
          id: {[Sequelize.Op.gte]: last.id}
        },
        limit: sync_limit
      })

      var blockmap = []

      for (var b of blocks) {
        // unpack precommits
        blockmap.push([r(b.precommits), b.header, b.ordered_tx_body])
      }

      ws.send(concat(inputMap('chain'), r(blockmap)))
    } else {
      // l("No blocks to sync after " + msg.toString('hex'))
    }






  // Other party defines credit limit to us (hub)
  } else if (inputType == 'setLimits') { 
    var [pubkey, sig, body] = r(msg)

    var limits = r(body)

    if (!ec.verify(body, sig, pubkey) || readInt(limits[0]) != methodMap('setLimits')) {
      l('Invalid message')
      return false
    }

    var ch = await me.getChannel(pubkey)

    ch.d.they_soft_limit = readInt(limits[1])
    ch.d.they_hard_limit = readInt(limits[2])

    await ch.d.save()
    l('Received updated limits')

  // other party wants to withdraw on-chain
  } else if (inputType == 'requestWithdraw') { 
    // partner asked us for instant withdrawal
    var [pubkey, sig, body] = r(msg)
    if (!ec.verify(body, sig, pubkey)) return false

    var ch = await me.getChannel(pubkey)

    var amount = readInt(r(body)[0])

    if (ch.d.they_input_amount > 0) {
      l('Peer already has withdrawal from us')
      return false
    }

    if (amount == 0 || amount > ch.they_insured) {
      l(`Peer asks for ${amount} but owns ${ch.they_insured}`)
      return false
    }

    var input = r([methodMap('withdrawal'),
      ch.ins.leftId,
      ch.ins.rightId,
      ch.nonce,
      amount])

    ch.d.they_input_amount = amount
    await ch.d.save()
    l('Gave withdrawal for ' + amount)

    me.send(pubkey, 'withdrawal', r([
      me.pubkey,
      ec(input, me.id.secretKey),
      r([amount])
    ]))


  // other party gives withdrawal on-chain
  } else if (inputType == 'withdrawal') { 
    var [pubkey, sig, body] = r(msg)

    var ch = await me.getChannel(pubkey)
    var amount = readInt(r(body)[0])

    var input = r([methodMap('withdrawal'),
      ch.ins.leftId,
      ch.ins.rightId,
      ch.nonce,
      amount])

    if (!ec.verify(input, sig, pubkey)) {
      l('Invalid withdrawal')
      return false
    }

    l('Got withdrawal for ' + amount)
    ch.d.input_amount = amount
    ch.d.input_sig = sig
    await ch.d.save()






















  } else if (inputType == 'ack') { // our payment was acknowledged
    var [pubkey, sig, body] = r(msg)
    var ch = await me.getChannel(pubkey)

    var [secret, stateSig] = r(body)

    if (!ec.verify(ch.d.getState(), stateSig, pubkey)) return l('Invalid state signed')

    ch.d.sig = stateSig
    ch.d.status = 'ready'

    await ch.d.save()

    if (secret.length == 0) return l('Got no secret ')

    var invoice = toHex(sha3(secret))

    var return_to = purchases[invoice]

    if (!return_to) return l('Nowhere to return to for ' + invoice, purchases)

    // ws from browser
    if (typeof return_to === 'function') {
      return_to({confirm: 'Payment succeeded!', secret: toHex(secret)})
    } else {
      var return_ch = await me.getChannel(return_to)
      me.send(return_to, 'ack', me.envelope(
        secret, ec(return_ch.d.getState(), me.id.secretKey)
      ))
    }

    delete(purchases[invoice])






  } else if (inputType == 'update') { // New payment arrived
    await me.updateChannel(msg)
  }
}
