module.exports = async (block) => {
  var finalblock = block.slice(Members.length * 64)

  var total_shares = 0

  for (var i = 0; i < Members.length; i++) {
    var sig = (block.slice(i * 64, (i + 1) * 64))

    if (sig.equals(Buffer.alloc(64))) {

    } else if (ec.verify(finalblock, sig, Members[i].block_pubkey)) {
      total_shares += Members[i].shares
    } else {
      l(`Invalid signature for a given block. Halt!`)
      // return false
    }
  }

  if (total_shares < K.majority) {
    l('Not enough shares on a block')
    return false
  }

  var [methodId,
    built_by,
    prev_hash,
    timestamp,
    ordered_tx] = r(finalblock)

  timestamp = readInt(timestamp)

  if (K.prev_hash != prev_hash.toString('hex')) {
    // l(`Must be based on ${K.prev_hash} but is using ${prev_hash}`)
    return false
  }
  
  if (readInt(methodId) != methodMap('block')) {
    return l('Wrong method for block')
  }

  if (finalblock.length > K.blocksize) {
    return l('Too long block')
  }

  if (timestamp < K.ts) {
    return l('New block from the past')
  }



  var meta = {
    inputs_volume: 0,
    outputs_volume: 0,
    parsed_tx: [],
    cron: []
  }

  // processing transactions one by one
  for (var i = 0; i < ordered_tx.length; i++) {
    var obj = await Tx.processTx(ordered_tx[i], meta)

    K.total_tx++
    K.total_tx_bytes += ordered_tx[i].length
  }

  if (PK.pending_tx.length > 0) {
    var raw = PK.pending_tx.map(tx=>Buffer.from(tx.raw, 'hex'))
    l("Rebroadcasting pending tx ", raw)
    me.send(me.next_member, 'tx', r(raw))
  }

  K.ts = timestamp
  K.prev_hash = toHex(sha3(finalblock))

  K.total_blocks++

  if (K.total_blocks % 50 == 0) l(`Processed block ${K.total_blocks} by ${readInt(built_by)}. Signed shares: ${total_shares}, tx: ${ordered_tx.length}`)


  if (finalblock.length < K.blocksize - 1000) {
    K.usable_blocks++
  }

  K.total_bytes += block.length
  K.bytes_since_last_snapshot += block.length

  // every x blocks create new installer
  if (K.bytes_since_last_snapshot > K.snapshot_after_bytes) {
    K.bytes_since_last_snapshot = 0

    meta.cron.push(['snapshot', K.total_blocks])
    var old_height = K.last_snapshot_height
    K.last_snapshot_height = K.total_blocks
  }

  // executing proposals that are due
  let disputes = await Insurance.findAll({
    where: {dispute_delayed: K.usable_blocks},
    include: {all: true}
  })

  for (let ins of disputes) {
    meta.cron.push(['autodispute', ins, resolveChannel(ins.insurance, ins.ondelta + ins.dispute_offdelta)])

    await ins.resolve()
  }

  // executing proposals that are due
  let jobs = await Proposal.findAll({
    where: {delayed: K.usable_blocks},
    include: {all: true}
  })

  for (let job of jobs) {
    var approved = 0
    for (let v of job.voters) {
      var voter = K.members.find(m => m.id == v.id)
      if (v.vote.approval && voter) {
        approved += voter.shares
      } else {
        // TODO: denied? slash some votes?
      }
    }

    if (approved >= K.majority) {
      await eval(`(async function() { ${job.code} })()`)
      if (job.patch.length > 0) {
        me.request_reload = true
        var pr = require('child_process').exec('patch -p1', (error, stdout, stderr) => {
          console.log(error, stdout, stderr)
        })
        pr.stdin.write(job.patch)
        pr.stdin.end()
      }

      meta.cron.push(['executed', job.desc, job.code, job.patch])
    }

    await job.destroy()
  }

  // only members do snapshots, as they require extra computations
  if (me.my_member && K.bytes_since_last_snapshot == 0) {
    fs.writeFileSync('data/k.json', stringify(K))

    var filename = 'Failsafe-' + K.total_blocks + '.tar.gz'

    require('tar').c({
      gzip: true,
      sync: false,
      portable: true,
      noMtime: true,
      file: 'private/' + filename,
      filter: (path, stat) => {
        // must be deterministic
        stat.mtime = null
        stat.atime = null
        stat.ctime = null
        stat.birthtime = null

        // skip /private and irrelevant things
        if (path.startsWith('./.') || path.match(/(private|DS_Store|node_modules|test)/)) {
          return false
        } else {
          return true
        }
      }
    }, ['.'], _ => {
      if (old_height > 1) { // genesis state is stored for analytics and member bootstraping 
        fs.unlink('private/Failsafe-' + old_height + '.tar.gz')
        l('Removed old snapshot and created ' + filename)
      }

    })
  }

  // save final block in blockchain db and broadcast
  await Block.create({
    prev_hash: Buffer.from(prev_hash, 'hex'),
    hash: sha3(finalblock),
    block: block,
    total_tx: ordered_tx.length,

    meta: (meta.parsed_tx.length + meta.cron.length > 0) ? JSON.stringify(meta) : null
  })

  if (me.my_member) {
    var blocktx = concat(inputMap('chain'), r([block]))
    // send finalblock to all websocket users if we're member

    if (me.wss) {
      me.wss.clients.forEach(client => client.send(blocktx))
    }
  }

  if (me.request_reload) {
    process.exit(0) // exit w/o error
  }
}
