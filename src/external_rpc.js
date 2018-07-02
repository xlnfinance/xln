// External RPC processes requests to our node coming from outside world.
// Also implements validator and hub functionality

externalRPCAuth = async (ws, args) => {
  let [pubkey, sig, body] = args

  if (ec.verify(r([methodMap('auth')]), sig, pubkey)) {
    //if (pubkey.equals(me.pubkey)) return false

    // wrap in custom WebSocketClient if it is a raw ws object
    if (ws.instance) {
      me.users[pubkey] = ws
    } else {
      me.users[pubkey] = new WebSocketClient()
      me.users[pubkey].instance = ws
    }

    /*if (me.my_hub) {
      let ch = await me.getChannel(pubkey, 1)
      ch.d.last_online = new Date()

      // testnet: instead of cloud backups hub shares latest state
      //me.send(pubkey, 'ack', me.envelope(0, ec(ch.state, me.id.secretKey)))

      if (ch.withdrawal_requested_at) {
        me.send(pubkey, 'requestWithdrawFrom', me.envelope(ch.insured))
      }
      await ch.d.save()
    }*/
  } else {
    l('Invalid auth attempt')
    return false
  }
}

externalRPCTx = async (args) => {
  // why would we be asked to add tx to block?
  if (!me.my_member) return false

  //if (me.my_member == me.next_member(1)) {
  args.map((tx) => {
    me.mempool.push(tx)
  })
  //} else {
  //  me.send(me.next_member(1), 'tx', msg)
  //}
}

externalRPCPropose = async (args) => {
  let [pubkey, sig, header, ordered_tx_body] = args
  let m = Members.find((f) => f.block_pubkey.equals(pubkey))

  if (me.status != 'propose' || !m) {
    return //l(`${me.status} not propose`)
  }

  if (header.length < 5) {
    return //l(`${m.id} voted nil`)
  }

  // ensure the proposer is the current one
  let proposer = me.next_member()
  if (m != proposer) {
    return l(`You ${m.id} are not the current proposer ${proposer.id}`)
  }

  if (!ec.verify(header, sig, pubkey)) {
    return l('Invalid proposer sig')
  }

  if (me.proposed_block.locked) {
    return l(
      `Still locked: ${toHex(me.proposed_block.header)} ${toHex(header)}`
    )
  }

  // no precommits means dry run
  if (!(await me.processBlock([], header, ordered_tx_body))) {
    l(`Bad block proposed ${toHex(header)}`)
    return false
  }

  // consensus operations are in-memory for now
  //l("Saving proposed block")
  me.proposed_block = {
    proposer: pubkey,
    sig: sig,

    header: bin(header),
    ordered_tx_body: ordered_tx_body
  }
}

externalRPCPrevotePrecommit = async (inputType, args) => {
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

externalRPCTestnet = async (args) => {
  let action = readInt(args[0])

  if (action == 1) {
    let asset = readInt(args[1])
    let amount = readInt(args[2])
    me.payChannel({
      address: args[3],
      amount: amount,
      invoice: Buffer.alloc(1),
      asset: asset
    })
  }
}

externalRPCChain = async (args) => {
  q('onchain', async () => {
    let started = K.total_blocks
    //l(`Sync since ${started} ${args.length}`)
    for (let block of args) {
      if (!(await me.processBlock(block[0], block[1], block[2]))) {
        l('Bad chain?')
        break
      }
    }

    if (K.total_blocks - started > 0) {
      // dirty hack to not backup k.json until all blocks are synced
      if (args.length >= K.sync_limit) {
        l('So many blocks. Syncing one more time')
        sync()
      } else {
        update_cache()
        react({}, false)

        // Ensure our last broadcasted batch was added
        if (PK.pending_batch) {
          let raw = fromHex(PK.pending_batch)
          l('Rebroadcasting pending tx ', raw.length)
          me.send(me.next_member(true), 'tx', r([raw]))
        } else {
          // time to broadcast our next batch then. (Delay to ensure validator processed the block)
          setTimeout(() => {
            me.broadcast()
          }, 2000)
        }
      }
    }
  })
}

externalRPCSync = async (ws, args) => {
  if (K.prev_hash == toHex(args[0])) {
    // sender is on last block
    return false
  }

  let last = await Block.findOne({
    attributes: ['id'],
    where: {
      prev_hash: args[0]
    }
  })

  if (last) {
    let chain = (await Block.findAll({
      attributes: ['precommits', 'header', 'ordered_tx_body'],
      where: {
        id: {[Op.gte]: last.id}
      },
      order: [['id', 'ASC']],
      limit: K.sync_limit
    })).map((b) => {
      return [r(b.precommits), b.header, b.ordered_tx_body]
    })

    ws.send(concat(bin(methodMap('chain')), r(chain)), wscb)
  } else {
    // l("No blocks to sync after " + msg.toString('hex'))
  }
}

externalRPCSetlimits = async (args) => {
  let [pubkey, sig, body] = args
  let limits = r(body)

  if (
    !ec.verify(body, sig, pubkey) ||
    readInt(limits[0]) != methodMap('setLimits')
  ) {
    l('Invalid message')
    return false
  }

  let ch = await me.getChannel(pubkey, readInt(limits[1]))

  ch.d.they_soft_limit = readInt(limits[2])
  ch.d.they_hard_limit = readInt(limits[3])

  l('Received updated limits')
  if (argv.syncdb) ch.d.save()
}

externalRPCRequestWithdrawFrom = async (args) => {
  if (me.CHEAT_dontwithdraw) {
    // if we dont give withdrawal or are offline for too long, the partner starts dispute
    return l('CHEAT_dontwithdraw')
  }

  // partner asked us for instant (mutual) withdrawal
  let [pubkey, sig, body] = args
  if (!ec.verify(body, sig, pubkey)) return false

  let [amount, asset] = r(body)
  amount = readInt(amount)
  asset = readInt(asset)

  let ch = await me.getChannel(pubkey, asset)

  if (ch.d.they_input_amount > 0) {
    l('Partner already has withdrawal from us')
    return false
  }

  if (amount == 0 || amount > ch.they_insured) {
    l(`Partner asks for ${amount} but owns ${ch.they_insured}`)
    return false
  }

  let withdrawal = r([
    methodMap('withdrawFrom'),
    ch.ins.leftId,
    ch.ins.rightId,
    ch.ins.nonce,
    amount,
    ch.d.asset
  ])

  ch.d.they_input_amount = amount
  if (argv.syncdb) ch.d.save()
  l('Gave withdrawal for ' + amount)

  me.send(
    pubkey,
    'withdrawFrom',
    r([me.pubkey, ec(withdrawal, me.id.secretKey), r([amount, asset])])
  )
}

externalRPCWithdrawFrom = async (args) => {
  //todo: ensure no conflicts happen if two parties withdraw from each other at the same time
  let [pubkey, sig, body] = args

  let [amount, asset] = r(body).map(readInt)

  let ch = await me.getChannel(pubkey, asset)

  let withdrawal = [
    methodMap('withdrawFrom'),
    ch.ins.leftId,
    ch.ins.rightId,
    ch.ins.nonce,
    amount,
    ch.d.asset
  ]

  if (!ec.verify(r(withdrawal), sig, pubkey)) {
    l('Invalid withdrawal ', withdrawal)
    return false
  }

  l('Got withdrawal for ' + amount)
  ch.d.input_amount = amount
  ch.d.input_sig = sig

  if (argv.syncdb) ch.d.save()
}

externalRPCUpdate = async (args) => {
  // New payment arrived
  let [pubkey, sig, body] = args

  if (!ec.verify(body, sig, pubkey)) {
    return l('Wrong input')
  }

  //l(msg.length, ' from ', trim(pubkey), toHex(sha3(msg)))

  // ackSig defines the sig of last known state between two parties.
  // then each transitions contains an action and an ackSig after action is committed
  let [method, asset, ackSig, transitions, debug] = r(body)
  if (methodMap(readInt(method)) != 'update') {
    loff('Invalid update input')
    return false
  }

  asset = readInt(asset)

  let flushable = await q([pubkey, asset], async () => {
    //loff(`--- Start update ${trim(pubkey)} - ${transitions.length}`)
    return me.updateChannel(pubkey, asset, ackSig, transitions, debug)
  })

  /*
  We MUST ack if there were any transitions, otherwise if it was ack w/o transitions
  to ourselves then do an opportunistic flush (flush if any). Forced ack here would lead to recursive ack pingpong!
  Flushable are other channels that were impacted by this update
  Sometimes sender is already included in flushable, so don't flush twice
  */

  let flushed = [me.flushChannel(pubkey, asset, transitions.length == 0)]

  if (flushable) {
    for (let fl of flushable) {
      // can be opportunistic also
      if (!fl.equals(pubkey)) {
        flushed.push(me.flushChannel(fl, asset, true))
      } else {
        loff('Tried to flush twice')
      }
      //await ch.d.requestFlush()
    }
  }
  await Promise.all(flushed)

  // use lazy react for external requests
  react({}, false)

  return
}

module.exports = (ws, msg) => {
  // uws gives ArrayBuffer, we create a view
  let msgb = bin(msg)
  let args = r(msgb.slice(1))
  let inputType = methodMap(msgb[0])

  // sanity checks 10mb
  if (msgb.length > 50000000) {
    l(`too long input ${msgb.length}`)
    return false
  }

  switch (inputType) {
    case 'auth':
      return externalRPCAuth(ws, args)
    case 'tx':
      return externalRPCTx(args)
    case 'propose':
      return externalRPCPropose(args)
    case 'prevote':
      return externalRPCPrevotePrecommit(inputType, args)
    case 'precommit':
      return externalRPCPrevotePrecommit(inputType, args)
    case 'testnet':
      return externalRPCTestnet(args)
    case 'chain':
      return externalRPCChain(args)
    case 'sync':
      return externalRPCSync(ws, args)
    case 'setLimits':
      return externalRPCSetlimits(args)
    case 'requestWithdrawFrom':
      return externalRPCRequestWithdrawFrom(args)
    case 'withdrawFrom':
      return externalRPCWithdrawFrom(args)
    case 'update':
      return externalRPCUpdate(args)
    default:
      return false
  }
}
