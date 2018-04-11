module.exports = async (block) => {
  var [precommits, header, ordered_tx_body] = r(block)

  var shares = 0
  var precommit_body = r([methodMap('precommit'), header])
  for (var i = 0; i < Members.length; i++) {
    //precommits[i] && precommits[i].length == 64 && 
    if (ec.verify(precommit_body, precommits[i], Members[i].block_pubkey)) {
      shares += Members[i].shares
    } else {
      l(`${i} missed a precommit for `, precommit_body)
    }
  }

  if (shares < K.majority) {
    return l(`Not enough precommits`)
  }

  var [methodId,
    built_by,
    prev_hash,
    timestamp,
    tx_root,
    db_hash] = r(header)

  timestamp = readInt(timestamp)

  if (K.prev_hash != prev_hash.toString('hex')) {
    // l(`Must be based on ${K.prev_hash} but is using ${prev_hash}`)
    return false
  }
  
  if (readInt(methodId) != methodMap('propose')) {
    return l('Wrong method for block')
  }

  if (ordered_tx_body.length > K.blocksize) {
    return l('Too long block')
  }

  if (timestamp < K.ts) {
    return l('New block from the past')
  }

  if (!sha3(ordered_tx_body).equals(tx_root)) {
    return l('Invalid tx_root')
  }

  if (!db_hash.equals(current_db_hash())) {
    l('DANGER: state mismatch. Some tx was not deterministic')
  }

  // >>> Given block is considered valid and final after this point <<<


  // In case we are member & locked on this height, unlock
  if (me.proposed_block.locked) {
    var locked_prev_hash = r(me.proposed_block.header)[2]

    if (prev_hash.equals(locked_prev_hash)) {
      me.proposed_block = {}
    }
  }

  // List of events/metadata about current block, used on Explorer page 
  var meta = {
    inputs_volume: 0,
    outputs_volume: 0,
    parsed_tx: [],
    cron: []
  }

  var ordered_tx = r(ordered_tx_body)

  // Processing transactions one by one
  // Long term TODO: parallel execution with pessimistic locks
  for (var i = 0; i < ordered_tx.length; i++) {
    var obj = await Tx.processTx(ordered_tx[i], meta)

    K.total_tx++
    K.total_tx_bytes += ordered_tx[i].length
  }




  // Current user ensures their tx was finalized
  if (PK.pending_tx.length > 0) {
    var raw = PK.pending_tx.map(tx=>Buffer.from(tx.raw, 'hex'))
    l("Rebroadcasting pending tx ", raw)
    me.send(me.next_member(1), 'tx', r(raw))
  }

  K.ts = timestamp
  K.prev_hash = toHex(sha3(header))

  K.total_blocks++

  if (K.total_blocks % 50 == 0) l(`Processed block ${K.total_blocks} by ${readInt(built_by)}. Signed shares: ${shares}, tx: ${ordered_tx.length}`)


  if (ordered_tx_body.length < K.blocksize - 1000) {
    K.usable_blocks++
  }

  K.total_bytes += block.length
  K.bytes_since_last_snapshot += block.length

  // Every x blocks create new installer
  if (K.bytes_since_last_snapshot > K.snapshot_after_bytes) {
    K.bytes_since_last_snapshot = 0

    meta.cron.push(['snapshot', K.total_blocks])
    var old_height = K.last_snapshot_height
    K.last_snapshot_height = K.total_blocks
  }

  // Auto resolving disputes that are due
  let disputes = await Insurance.findAll({
    where: {dispute_delayed: K.usable_blocks},
    include: {all: true}
  })

  for (let ins of disputes) {
    meta.cron.push(['autodispute', ins, resolveChannel(ins.insurance, ins.ondelta + ins.dispute_offdelta)])

    await ins.resolve()
  }


  // Executing onchaing gov proposals that are due
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
    hash: sha3(header),

    block: block, // sigs, header and tx all in one

    total_tx: ordered_tx.length,
    meta: (meta.parsed_tx.length + meta.cron.length > 0) ? JSON.stringify(meta) : null
  })


  if (me.request_reload) {
    process.exit(0) // exit w/o error
  }
}
