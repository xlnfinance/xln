WebSocketClient = require('./ws')
stringify = require('./stringify')
Tx = require('./tx')

class Me {
  async init(username, seed) {
    this.username = username

    this.is_hub = false

    this.seed = seed
    this.id = nacl.sign.keyPair.fromSeed(this.seed)
    this.id.publicKey = bin(this.id.publicKey)

    this.mempool = []
    this.status = 'await'

    this.sockets = {}

    this.block_keypair = nacl.sign.keyPair.fromSeed(kmac(this.seed, 'block'))
    this.block_pubkey = bin(this.block_keypair.publicKey).toString('hex')

  }

  async byKey(pk){
    if(!pk) pk = this.id.publicKey
    return await User.findOne({
      where: { pubkey: bin(pk) }
    })
  }


  async processMempool(){
    var ordered_tx = []
    var total_size = 0

    var pseudo_balances = {}

    for(var candidate of me.mempool){
      if(total_size + candidate.length > K.blocksize) break;


      var result = await Tx.processTx(candidate, pseudo_balances)
      if(result.success){
        ordered_tx.push(candidate)
        total_size += candidate.length
      }else{
        l(result.error)
        // punish submitter ip
      }
    }

    // flush it
    me.mempool = []



    var block_number = K.total_blocks
    block_number++

    var prev_hash = K.prev_hash
    // block has current height, hash of prev block , ts()

    me.precommit = r([
      block_number,
      methodMap('block'),
      Buffer.from(prev_hash, 'hex'),
      ts(),
      ordered_tx
    ])

    d("Built ordered ",ordered_tx)


    me.my_member.sig = ec(me.precommit, me.block_keypair.secretKey)

    if(K.majority > 1){
      var needSig = concat(
        inputMap('needSig'),
        r([
          bin(this.id.publicKey),
          me.my_member.sig,
          me.precommit
        ])
      )

      me.members.map((c)=>{
        if(c.socket && c != me.my_member)
        c.socket.send(needSig)
      })
    }

    return me.precommit
  }




  async broadcast(method, args){
    var methodId = methodMap(method)

    me.record = await me.byKey()

    switch(method){
      case 'settle':
      case 'settleUser':


        var confirm = "Broadcasted globally!"
        break
      case 'propose':
        assert(args[0].length > 1, 'Rationale is required')

        if(args[2]){
          //diff -urB . ../yo
          args[2] = fs.readFileSync('../'+args[2])
        }

        args = r(args)

        var confirm = "Proposal submitted!"
        break

      case 'voteApprove':
      case 'voteDeny':

        var confirm = "You voted!"

        break
    }

    var to_sign = r([me.record.nonce, methodId, args])

    var tx = r([
      me.record.id, bin(ec(to_sign, me.id.secretKey)), methodId, args
    ])


    confirm += ` Tx size ${tx.length}b, fee ${tx.length * K.tax}.`

    if(me.my_member && me.my_member == me.next_member){
      me.mempool.push(tx)
    }else{
      me.sendMember('tx', tx)

      l(r(tx))
    }

    l("Just broadcasted ", tx)

    return confirm;
  }


  // this is off-chain for any kind of p2p authentication
  // no need to optimize for bandwidth
  // so full pubkey is used instead of id and JSON is used as payload
  offchainAuth(){

    return r([
      bin(this.id.publicKey),
      bin(ec(r([0, methodMap('auth')]), this.id.secretKey))      
    ])

  }

  offchainVerify(token){
    var [pubkey, sig] = r(token)

    if(ec.verify(r([0, methodMap('auth')]), sig, pubkey)){
      l('verified success! ')
      return {
        signer: pubkey
      }
    }else{
      return false
    }
  }

  async start(){
    // in json pubkeys are in hex
    this.record = await this.byKey()

    for(var m of this.members){
      if(this.record && this.record.id == m.id){
        this.my_member = m
        this.is_hub = this.my_member.hub
      }
    }
   
    l("start caching")
    setInterval(cache, 10000)

    if(this.my_member){

      setInterval(require('../private/member'), 2000)


      for(var m of this.members){
        if( this.my_member != m ){
          // we need to have connections ready to all members
          this.sendMember('auth', me.offchainAuth(), i)
        }
      }

      if(this.is_hub){
        setInterval(async ()=>{
          var h = await (require('../private/hub')())

          if(h.ins.length > 0 || h.outs.length > 0){
            await this.broadcast('settle', r([0, h.ins, h.outs]))
          }
          
        }, K.blocktime*2000)
      }
    }else{
      // keep connection to hub open
      this.sendMember('auth', this.offchainAuth(), 0)

      l("Set up sync")
      setInterval(sync, K.blocktime*1000)
    }


  }






  // we abstract away from Internet Protocol and imagine anyone just receives input out of nowhere
  // this input is of few different kinds:
  // it can be from member to another member to persist a socket between them
  // or it can be a new block received from another member to add a signature
  // or it can be a fully signed block to be applied
  // or a new tx from anyone to be added to block or passed to current member
  async processInput(ws, tx){
    tx = bin(tx)
    // sanity checks 100mb
    if(tx.length > 100000000){
      l(`too long input ${(tx).length}`)
      return false
    }

    var inputType = inputMap(tx[0])

    tx = tx.slice(1)

    l('New input: '+inputType)

    if(inputType == 'auth'){
      let obj = me.offchainVerify(tx)
      l('Someone connected: '+toHex(obj.signer))

      wss.users[obj.signer] = ws

      if(me.is_hub){ 
        // offline delivery if missed
        var ch = await me.channel(obj.signer)
        if(ch.delta_record.id){
          let negative = ch.delta_record.delta < 0 ? 1 : null

          var body = r([
            methodMap('delta'), obj.signer, ch.delta_record.nonce, negative, (negative ? -ch.delta_record.delta : ch.delta_record.delta), ts()
          ])

          var sig = ec(body, me.id.secretKey)
          var tx = concat(inputMap('mediate'), r([
            bin(me.id.publicKey), bin(sig), body, 0
          ]))
          wss.users[obj.signer].send(tx)
        }
      }


      var m = me.members.find(f=>f.block_pubkey.equals(obj.signer))
      if(m){
        m.socket = ws 
      }

      return false
    }else if (inputType == 'tx'){

      // 2. is it us?
      if(me.my_member && me.my_member == me.next_member){
        l('We are next, adding to mempool :', r(tx))

        me.mempool.push(bin(tx))
      }else{
        if(me.next_member.socket){
          l('passing to next '+me.next_member.id)
          me.next_member.socket.send(concat(inputMap('tx'),tx))
        }else{
          l('No active socket to current member: '+me.next_member.id)
        }

      }
    }else if (inputType == 'needSig'){
      var [pubkey, sig, block] = r(tx)
      var m = me.members.find(f=>f.block_pubkey.equals(pubkey) )

      // ensure the block is non repeating
      if(m && ec.verify(block, sig, pubkey)  ){
        l(`${m.id} asks us to sign their block!`)

        m.socket.send(concat(
          inputMap('signed'),
          r([
            bin(me.id.publicKey),
            ec(block, me.id.secretKey)
          ])
        ))
      }

      // a member needs your signature


    }else if (inputType == 'faucet'){

      await me.payChannel(tx, Math.round(Math.random() * 4000))

    }else if (inputType == 'signed'){
      var [pubkey, sig] = r(tx)

      var m = me.members.find(f=>f.block_pubkey.equals(pubkey) )

      assert(me.status == 'precommit', 'Not expecting any sigs')

      if(m && ec.verify(me.precommit, sig, pubkey)){
        m.sig = sig
        //l(`Received another sig from  ${m.id}`)
      }else{
        l("this sig doesn't work for our block")
      }


    }else if (inputType == 'chain'){
      var chain = r(tx)
      for(var block of chain){
        await me.processBlock(block)
      }
    }else if (inputType == 'sync'){

      var last = await Block.findOne({where: {
        prev_hash: tx
      }})

      if(last){
        l("Sharing blocks since "+last.id)

        var blocks = await Block.findAll({
          where: {
            id: {[Sequelize.Op.gte]: last.id}
          },
          limit: 100
        })

        var blockmap = []

        for(var b of blocks){
          blockmap.push(b.block)
        }

        ws.send(concat(inputMap('chain'), r(blockmap)))
      }else{
        l("Wrong chain?")
      }

    }else if (inputType == 'mediate'){
      var [pubkey, sig, body, mediate_to] = r(tx)

      if(ec.verify(body, sig, pubkey)){

        var [counterparty, nonce, delta, instant_until] = me.parseDelta(body)



        if(me.is_hub){
          assert(readInt(counterparty) == 1)

          var ch = await me.channel(pubkey)

          l(nonce, ch.delta_record.nonce+1)

          assert(nonce >= ch.delta_record.nonce, `${nonce} ${ch.delta_record.nonce}`)
          ch.delta_record.nonce++
          //assert(nonce == ch.delta_record.nonce)

          l('delta ', ch.delta_record.delta, delta)

          var amount = ch.delta_record.delta - delta

          l(`Sent ${amount} out of ${ch.total}`)

          assert(amount > 0 && amount <= ch.total, `Got ${amount} is limited by collateral ${ch.total}`)

          ch.delta_record.delta = delta
          ch.delta_record.sig = r([pubkey, sig, body]) //raw delta

          await ch.delta_record.save()

          var fee = Math.round(amount * K.hub_fee)
          if(fee == 0) fee = K.hub_fee_base

          await me.payChannel(mediate_to, amount - fee)

        }else{
          // is it for us?
          assert(counterparty.equals(bin(me.id.publicKey)))

          var hub = await User.findById(1)

          assert(hub.pubkey.equals(pubkey))

          var ch = await me.channel(1)

          l(delta, ch.delta_record.delta)

          // for users, delta of deltas is reversed
          var amount = parseInt(delta - ch.delta_record.delta)

          assert(amount > 0)

          l(`${amount} received payment of  ${delta}`)

          ch.delta_record.nonce++
          assert(nonce >= ch.delta_record.nonce)

          ch.delta_record.delta = delta
          ch.delta_record.sig = r([pubkey, sig, body]) //raw delta

          await ch.delta_record.save()

          if(me.browser){
            me.browser.send(JSON.stringify({
              result: {ch: ch},
              id: 1
            }))
          }

        }

      }
    }

  }

  parseDelta(body){
    var [method, counterparty, nonce, negative, delta, instant_until] = r(body)

    nonce = readInt(nonce)
    method = readInt(method)
    instant_until = readInt(instant_until)

    delta = negative.equals(Buffer.alloc(0)) ? readInt(delta) : -readInt(delta)

    assert(method == methodMap('delta'))

    return [counterparty, nonce, delta, instant_until]
  }



  async payChannel(who, amount, mediate_to){
    l(`payChannel ${amount} to ${who}`)

    var ch = await me.channel(who)

    if(me.is_hub){
      ch.delta_record.delta += amount
      ch.delta_record.nonce++

      let negative = ch.delta_record.delta < 0 ? 1 : null

      var body = r([
        methodMap('delta'), who, ch.delta_record.nonce, negative, (negative ? -ch.delta_record.delta : ch.delta_record.delta), ts()
      ])

      var sig = ec(body, me.id.secretKey)
      var tx = concat(inputMap('mediate'), r([
        bin(me.id.publicKey), bin(sig), body, 0
      ]))

      if(wss.users[who]){
        wss.users[who].send(tx)
      }else{
        l(`not online, deliver later? ${tx}`)
      }
  
      await ch.delta_record.save()

    }else{
      if(amount < 0 || amount > ch.total){
        return [false, "Not enough funds"]
      }

      ch.delta_record.delta -= amount
      ch.delta_record.nonce++

      let negative = ch.delta_record.delta < 0 ? 1 : null

      var body =r([
        methodMap('delta'), who, ch.delta_record.nonce, negative, (negative ? -ch.delta_record.delta : ch.delta_record.delta), ts()
      ])

      var sig = ec(body, me.id.secretKey)

      me.sendMember('mediate', r([bin(me.id.publicKey), bin(sig), body, mediate_to]), 0)
      // todo: ensure delivery
  
      await ch.delta_record.save()

    }

    return [true, false]

  }

  async channel(counterparty){
    var r = {
      // onchain fields
      collateral: 0,
      settled: 0,
      nonce: 0,
      
      // offchain delta_record

      // for convenience
      settled_delta: 0,
      failsafe: 0,
      total: 0
    }

    me.record = await me.byKey()

    if(me.is_hub){
      var user = await me.byKey(counterparty)

      if(user){

        var ch = await Collateral.find({where: {
          userId: user.id,
          hubId: 1
        }})

        if(ch){
          r.collateral = ch.collateral
          r.settled = ch.settled
          r.nonce = ch.nonce
        }
      }


      var delta = await Delta.findOrBuild({
        where: {
          hubId: 1,
          userId: counterparty
        },defaults: {
          delta: 0,
          instant_until: 0,
          nonce: 0
        }
      })

    }else{
      var hubId = counterparty

      if(me.record){
        var ch = await Collateral.find({where: {
          userId: me.record.id,
          hubId: hubId
        }})

        if(ch){
          r.collateral = ch.collateral
          r.settled = ch.settled
          r.nonce = ch.nonce
        }
      }else{

      }

      var delta = await Delta.findOrBuild({
        where: {
          hubId: hubId,
          userId: bin(me.id.publicKey)
        },defaults: {
          delta: 0,
          instant_until: 0,
          nonce: 0
        }
      })

    }


    r.delta_record = delta[0]

    r.settled_delta = r.settled + r.delta_record.delta

    r.total = r.collateral + r.settled_delta

    if(r.settled_delta >= 0){
      r.failsafe = r.collateral
    }else{
      r.failsafe = r.collateral + r.settled_delta
    }
  
    return r
  }




  async processBlock(block){
    var finalblock = block.slice(me.members.length * 64)

    d(`Processing a new block, length ${block.length}`)
    var total_shares = 0

    for(var i = 0;i<me.members.length;i++){
      var sig = (block.slice(i * 64, (i+1) * 64))

      if(sig.equals(Buffer.alloc(64))){

      }else if(ec.verify(finalblock, sig, me.members[i].block_pubkey)){
        total_shares += me.members[i].shares
      }else{
        l(`Invalid signature for a given block. Halt!`)
        //return false
      }


    }

    if(total_shares < K.majority){
      l("Not enough shares on a block")
      return false
    }


    var [block_number,
      methodId,
      prev_hash,
      timestamp,
      ordered_tx] = r(finalblock)

    block_number = readInt(block_number)
    timestamp = readInt(timestamp)
    prev_hash = prev_hash.toString('hex')

    assert(readInt(methodId) == methodMap('block'), 'Wrong method for block')
    assert(finalblock.length <= K.blocksize, 'Invalid block')

    if(timestamp < K.ts){
      l('New block from the past')
      return false 
    }
    //, 


    if(K.prev_hash != prev_hash){
      l(`Must be based on ${K.prev_hash} but is using ${prev_hash}`)
      return false
    }

    d(`Processing ${block_number} (before ${K.total_blocks}) hash ${K.prev_hash}. Timestamp ${timestamp} Total shares: ${total_shares}, tx to process: ${ordered_tx.length}`)

    // processing transactions one by one
    for(var i = 0;i<ordered_tx.length;i++){
      await Tx.processTx(ordered_tx[i])
      K.total_tx++
      K.total_tx_bytes+=ordered_tx[i].length
    }


    K.ts = timestamp
    K.prev_hash = toHex(sha3(finalblock))

    K.total_blocks++
    if(finalblock.length < K.blocksize-1000){
      K.usable_blocks++
    }

    K.total_bytes += block.length
    K.bytes_since_last_snapshot+=block.length

    // every x blocks create new installer
    if(K.bytes_since_last_snapshot > K.snapshot_after_bytes){
      K.bytes_since_last_snapshot = 0
      K.last_snapshot_height = K.total_blocks
    }else{

    }


    // cron jobs
    if(K.total_blocks % 100 == 0){
    }

    // executing proposals that are due
    let to_execute = await Proposal.findAll({
      where: {delayed: K.usable_blocks},
      include: {all: true}
    })

    for(let job of to_execute){
      var total_shares = 0
      for(let v of job.voters){
        var voter = K.members.find(m=>m.id==v.id)
        if(v.vote.approval){
          total_shares += voter.shares
        }else{

        }
      }

      if(total_shares < K.majority) continue

      l("Evaling "+job.code)

      l(await eval(`(async function() { ${job.code} })()`))

      var patch = job.patch

      if(patch.length > 0){
        me.request_reload = true
        var pr = require('child_process').exec('patch -p1', (error, stdout, stderr) => {
            console.log(error, stdout, stderr);
        });
        pr.stdin.write(patch)
        pr.stdin.end()

        l('Patch applied! Restarting...')
      }

    }




    // block processing is over, saving current K

    fs.writeFileSync('data/k.json', stringify(K))

    if(K.bytes_since_last_snapshot == 0){
      trustlessInstall()
    }


    // save final block in blockchain db and broadcast
    if(me.my_member){
      await Block.create({
        prev_hash: Buffer.from(prev_hash, 'hex'),
        hash: sha3(finalblock),
        block: block
      })

      var blocktx = concat(inputMap('chain'), r([block]))
      // send finalblock to all websocket users if we're member
      if(me.wss){
        me.wss.clients.forEach(client=>client.send(blocktx))
      }
    }

    if(me.request_reload){
      process.exit(0) // exit w/o error
    }



  }




  sendMember(method, tx, memberIndex){
    if(!memberIndex) memberIndex = 0
      // if we are member, just send it to current
      // connecting to geo-selected nearest member (lowest latency)

    tx = concat(inputMap(method), tx)
 
    var m = me.members[memberIndex]
    if(m.socket){
      m.socket.send(tx)
    }else{
      m.socket = new WebSocketClient()

      m.socket.onmessage = tx=>{
        l('from member ')
        me.processInput(m.socket,bin(tx))
      }

      m.socket.onopen = function(e){
        if(me.id)
        m.socket.send(concat(inputMap('auth'), me.offchainAuth()))

        l("Sending to member ", tx)
        m.socket.send(tx)
      }

      m.socket.open('ws://'+m.location)
    }


  
  }

}

module.exports = {
  Me: Me
}



