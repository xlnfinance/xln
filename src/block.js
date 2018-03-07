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


  l(`Processing block ${K.total_blocks + 1} by ${readInt(built_by)}. Signed shares: ${total_shares}, tx: ${ordered_tx.length}`)

  var meta = {
    inputs_volume: 0,
    outputs_volume: 0,
    parsed_tx: []
  }

  // processing transactions one by one
  for (var i = 0; i < ordered_tx.length; i++) {
    var obj = await Tx.processTx(ordered_tx[i], meta)

    K.total_tx++
    K.total_tx_bytes += ordered_tx[i].length
  }

  if (PK.pending_tx.length > 0) {
    l("Rebroadcasting pending tx")
    PK.pending_tx.map(tx=>{
      me.send(me.next_member, 'tx', Buffer.from(tx.raw, 'hex'))
    })
  }

  K.ts = timestamp
  K.prev_hash = toHex(sha3(finalblock))

  K.total_blocks++
  if (finalblock.length < K.blocksize - 1000) {
    K.usable_blocks++
  }

  K.total_bytes += block.length
  K.bytes_since_last_snapshot += block.length

  // every x blocks create new installer
  if (K.bytes_since_last_snapshot > K.snapshot_after_bytes) {
    K.bytes_since_last_snapshot = 0

    var old_snapshot = K.last_snapshot_height
    K.last_snapshot_height = K.total_blocks
  }

  // cron jobs
  if (K.total_blocks % 100 == 0) {
  }

  // executing proposals that are due
  let disputes = await Insurance.findAll({
    where: {dispute_delayed: K.usable_blocks},
    include: {all: true}
  })

  for (let ins of disputes) {
    await ins.resolve()
    l('Resolved')
  }

  // executing proposals that are due
  let jobs = await Proposal.findAll({
    where: {delayed: K.usable_blocks},
    include: {all: true}
  })

  for (let job of jobs) {
    var total_shares = 0
    for (let v of job.voters) {
      var voter = K.members.find(m => m.id == v.id)
      if (v.vote.approval && voter) {
        total_shares += voter.shares
      } else {

      }
    }

    if (total_shares < K.majority) continue

    l('Evaling ' + job.code)

    l(await eval(`(async function() { ${job.code} })()`))

    var patch = job.patch

    if (patch.length > 0) {
      me.request_reload = true
      var pr = require('child_process').exec('patch -p1', (error, stdout, stderr) => {
        console.log(error, stdout, stderr)
      })
      pr.stdin.write(patch)
      pr.stdin.end()

      l('Patch applied! Restarting...')
    }

    await job.destroy()
  }

  // block processing is over, saving current K
  fs.writeFileSync('data/k.json', stringify(K))

  if (K.bytes_since_last_snapshot == 0) {
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

        // skip /private (blocks sqlite, proofs, local config)
        // tests, and all hidden/dotfiles
        if (path.startsWith('./.') || path.match(/(DS_Store|private|node_modules|test)/)) {
          return false
        } else {
          return true
        }
      }
    }, ['.'], _ => {
      fs.unlink('private/Failsafe-' + old_snapshot + '.tar.gz', () => {
        l('Removed old snapshot and created ' + filename)
      })
    })
  }

  // save final block in blockchain db and broadcast
  await Block.create({
    prev_hash: Buffer.from(prev_hash, 'hex'),
    hash: sha3(finalblock),
    block: block,
    total_tx: ordered_tx.length,

    meta: JSON.stringify(meta)
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
