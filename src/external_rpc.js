// External RPC processes requests to our node coming from outside world.
// Also implements validator and hub functionality

module.exports = async (ws, input) => {
  var msg = Buffer.from(input)

  // sanity checks 10mb
  if (msg.length > 10000000) {
    l(`too long input ${msg.length}`)
    return false
  }

  var inputType = methodMap(msg[0])

  // how many blocks to share at once
  var sync_limit = 100

  msg = msg.slice(1)

  // ignore some too frequest RPC commands
  /*if (
    ['update', 'chain', 'sync', 'propose', 'prevote', 'precommit'].indexOf(
      inputType
    ) == -1
  )*/

  //l('External RPC: ' + inputType)

  if (inputType == 'auth') {
    var [pubkey, sig, body] = r(msg)

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
        var ch = await me.getChannel(pubkey, 1)
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

    // accepts array of tx
  } else if (inputType == 'tx') {
    // why would we be asked to add tx to block?
    if (!me.my_member) return false

    //if (me.my_member == me.next_member(1)) {
    r(msg).map((tx) => {
      me.mempool.push(tx)
    })
    //} else {
    //  me.send(me.next_member(1), 'tx', msg)
    //}

    // another member wants a sig
  } else if (inputType == 'propose') {
    var [pubkey, sig, header, ordered_tx_body] = r(msg)

    var m = Members.find((f) => f.block_pubkey.equals(pubkey))

    if (me.status != inputType || !m) {
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
        'We are still locked on previous block:',
        me.proposed_block.header,
        header
      )
    }

    // no precommits means dry run
    if (!await me.processBlock([], header, ordered_tx_body)) {
      l('Bad block proposed')
      return false
    }

    l('Got block ', toHex(header))

    // consensus operations are in-memory for now
    //l("Saving proposed block")
    me.proposed_block = {
      proposer: pubkey,
      sig: sig,

      header: header,
      ordered_tx_body: ordered_tx_body
    }
  } else if (inputType == 'prevote' || inputType == 'precommit') {
    var [pubkey, sig, body] = r(msg)
    var [method, header] = r(body)

    var m = Members.find((f) => f.block_pubkey.equals(pubkey))

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
      ec.verify(
        r([methodMap(inputType), me.proposed_block.header]),
        sig,
        pubkey
      )
    ) {
      m[inputType] = sig
      //l(`Received ${inputType} from ${m.id}`)
    } else {
      l(
        `This sig by ${m.id} doesn't work for our block ${toHex(
          me.proposed_block.header
        )}`
      )
    }
    // testnet stuff
  } else if (inputType == 'testnet') {
    if (msg[0] == 1) {
      await me.payChannel({
        destination: msg.slice(2),
        amount: 10000000,
        invoice: Buffer.alloc(1),
        asset: msg[1]
      })
    }

    // sync requests latest blocks, chain returns chain
  } else if (inputType == 'chain') {
    await q('onchain', async () => {
      var chain = r(msg)

      var started = K.total_blocks
      for (var block of chain) {
        if (!await me.processBlock(block[0], block[1], block[2])) {
          l('Bad chain?')
          break
        }
      }

      // dirty hack to not backup k.json until all blocks are synced
      if (chain.length == sync_limit) {
        sync()
      } else {
        fs.writeFileSync(datadir + '/onchain/k.json', stringify(K))
        if (K.total_blocks - started > 0) {
          // something new happened - cache
          cache()

          // Ensure our last broadcasted batch was added
          if (PK.pending_batch) {
            var raw = fromHex(PK.pending_batch)
            l('Rebroadcasting pending tx ', raw.length)
            me.send(me.next_member(true), 'tx', r([raw]))
          } else {
            // time to broadcast our next batch then. (Delay to ensure validator processed the block)
            //setTimeout(() => {
            me.broadcast()
            //}, 500)
          }
        }
      }
    })
  } else if (inputType == 'sync') {
    var last = await Block.findOne({
      attributes: ['id'],
      where: {
        prev_hash: msg
      }
    })

    if (last) {
      let chain = (await Block.findAll({
        attributes: ['precommits', 'header', 'ordered_tx_body'],
        where: {
          id: {[Op.gte]: last.id}
        },
        order: [['id', 'ASC']],
        limit: sync_limit
      })).map((b) => {
        return [r(b.precommits), b.header, b.ordered_tx_body]
      })

      ws.send(concat(bin(methodMap('chain')), r(chain)))
    } else {
      // l("No blocks to sync after " + msg.toString('hex'))
    }

    // Other party defines credit limit to us
  } else if (inputType == 'setLimits') {
    var [pubkey, sig, body] = r(msg)

    var limits = r(body)

    if (
      !ec.verify(body, sig, pubkey) ||
      readInt(limits[0]) != methodMap('setLimits')
    ) {
      l('Invalid message')
      return false
    }

    var ch = await me.getChannel(pubkey, readInt(limits[1]))

    ch.d.they_soft_limit = readInt(limits[2])
    ch.d.they_hard_limit = readInt(limits[3])

    await ch.d.save()
    l('Received updated limits')
  } else if (inputType == 'requestWithdrawFrom') {
    if (me.CHEAT_dontwithdraw) {
      // if we dont give withdrawal or are offline for too long, the partner starts dispute
      return l('CHEAT_dontwithdraw')
    }

    // partner asked us for instant (mutual) withdrawal
    var [pubkey, sig, body] = r(msg)
    if (!ec.verify(body, sig, pubkey)) return false

    var [amount, asset] = r(body)
    amount = readInt(amount)
    asset = readInt(asset)

    var ch = await me.getChannel(pubkey, asset)

    if (ch.d.they_input_amount > 0) {
      l('Peer already has withdrawal from us')
      return false
    }

    if (amount == 0 || amount > ch.they_insured) {
      l(`Peer asks for ${amount} but owns ${ch.they_insured}`)
      return false
    }

    var input = r([
      methodMap('withdrawFrom'),
      ch.ins.leftId,
      ch.ins.rightId,
      ch.nonce,
      amount,
      ch.ins.asset
    ])

    ch.d.they_input_amount = amount
    await ch.d.save()
    l('Gave withdrawal for ' + amount)

    me.send(
      pubkey,
      'withdrawFrom',
      r([me.pubkey, ec(input, me.id.secretKey), r([amount, asset])])
    )

    // other party gives withdrawal onchain
    //todo: ensure no conflicts happen if two parties withdraw from each other at the same time
  } else if (inputType == 'withdrawFrom') {
    var [pubkey, sig, body] = r(msg)

    var [amount, asset] = r(body)
    amount = readInt(amount)
    asset = readInt(asset)

    var ch = await me.getChannel(pubkey, asset)

    var input = r([
      methodMap('withdrawFrom'),
      ch.ins.leftId,
      ch.ins.rightId,
      ch.nonce,
      amount,
      ch.ins.asset
    ])

    if (!ec.verify(input, sig, pubkey)) {
      l('Invalid withdrawal')
      return false
    }

    l('Got withdrawal for ' + amount)
    ch.d.input_amount = amount
    ch.d.input_sig = sig
    await ch.d.save()
  } else if (inputType == 'update') {
    // New payment arrived
    let [pubkey, sig, body] = r(msg)

    if (!ec.verify(body, sig, pubkey)) {
      return l('Wrong input')
    }

    //l(msg.length, ' from ', trim(pubkey), toHex(sha3(msg)))

    // ackSig defines the sig of last known state between two parties.
    // then each transitions contains an action and an ackSig after action is committed
    // debugState/signedState are purely for debug phase
    let [method, asset, ackSig, transitions, debugState, signedState] = r(body)
    if (methodMap(readInt(method)) != 'update') {
      loff('Invalid update input')
      return false
    }

    asset = readInt(asset)

    let flushable = await q([pubkey, asset], async () => {
      //loff(`--- Start update ${trim(pubkey)} - ${transitions.length}`)
      return me.updateChannel(
        pubkey,
        asset,
        ackSig,
        transitions,
        debugState,
        signedState
      )
    })

    /*
    We MUST ack if there were any transitions, otherwise if it was ack w/o transitions 
    to ourselves then do an opportunistic flush (flush if any). Forced ack here would lead to recursive ack pingpong!
    Flushable are other channels that were impacted by this update
    Sometimes sender is already included in flushable, so don't flush twice

    */

    var flushed = [me.flushChannel(pubkey, asset, transitions.length == 0)]

    if (flushable) {
      for (var fl of flushable) {
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

    return //
  }
}
