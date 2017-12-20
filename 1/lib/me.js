WebSocketClient = require('./ws')

const stringify = require('./stringify')


class Me {


  async init(username, seed) {
    this.username = username

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





  sign(omitted_buf, payload) {
    var to_sign = concat(omitted_buf, payload)
    var sig = nacl.sign.detached(to_sign, this.id.secretKey)

    // get id for my pubkey and store as big endian in a buffer
    // return detached id sig
    return concat(write32(this.record.id), sig, payload)
  }

  parseTx(tx){
    var parsedTx = {
      id: tx.slice(0, 4).readUInt32BE(),
      sig: tx.slice(4, 68),
      methodId: tx.slice(68, 72).readUInt32BE(),
      args: tx.slice(72, tx.length)
    }

    return parsedTx
  }

  async processMempool(){
    var ordered_tx = []
    var total_size = 0

    var pseudo_balances = {}

    d("Start mempool processing")

    for(var i = 0;i < me.mempool.length;i++){
      var tx = me.mempool[i]

      if(total_size + tx.length > K.blocksize) break;

      var result = await me.processTx(tx, pseudo_balances)
      if(result.success){
        ordered_tx.push(tx)
        total_size += tx.length
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
      write32(block_number),
      methodMap('block'),
      Buffer.from(prev_hash, 'hex'),
      write32(ts()),
      ordered_tx
    ])

    d("Built ordered ",ordered_tx)


    me.my_member.sig = nacl.sign.detached(me.precommit, me.block_keypair.secretKey)

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

  async processTx(tx, pseudo_balances) {
    var {id, sig, methodId, args} = me.parseTx(tx);

    var signer = await User.findById(id)

    if(!signer)
    return {error: "This user doesn't exist"}

    var method = methodMap(methodId)

    if(allowedOnchain.indexOf(method) == -1)
    return {error: 'No such method exposed onchain'}


    // we prepend omitted vars to not bloat tx size
    var payload = concat(write32(signer.nonce), write32(methodId), args)

    if(!nacl.sign.detached.verify(payload, sig, signer.pubkey))
    return {error:"Invalid signature"}

    // total tax is a sum of
    // size tax is for consuming bandwidth (all tx)

    var tax = Math.round(K.tax_per_byte * tx.length)

    // gas tax is for consuming computational resources (optional)
    // storage tax is consumed both monthly and
    if(signer.balance < tax)
    return {error: "Not enough balance to cover tx fee"}


    // This is precommit, so no need to apply tx and change db
    if(pseudo_balances){
      if(pseudo_balances[signer.id]){
        return {error: 'Only one tx per block per account currently allowed'}
      }else{
        pseudo_balances[signer.id] = true
        return {success: true}
      }
    }



    l(`ProcessTx: ${method} with ${args.length} by ${id}`)
    // Validation is over, fee is ours
    signer.balance -= tax
    signer.nonce += 1
    //signer.save()


    switch(method){
      case 'propose':
        var execute_on = K.usable_blocks + K.voting_period //60*24
        var new_proposal = await Proposal.create({
          change: args,
          kindof: method,
          delayed: execute_on
        })
        l(`Added ${new_proposal.change} proposal!`)
        K.proposals_created++

        break
      // don't forget BREAK
      // we use fall-through for methods covered by same code
      // settle uses relative user_id, users settle for absolute hub_id
      case 'settle':
      case 'settleUser':      
        // 1. collect all ins collateral
        var [assetType, inputs, outputs] = r(args)

        var is_hub = (method == 'settle')

        for(var i=0;i<inputs.length;i++){
          // get withdrawal tx
          var input = inputs[i]

          // you can't withdraw from non existant channel
          var input_id = input.slice(0, 4).readUInt32BE()
          var input_ch = await Collateral.find({
            where: {
              userId: is_hub ? input_id : id,
              hubId: is_hub ? id : input_id,
              assetType: assetType
            },
            include: {all: true}
          })

          // getting user who signed this input
          var input_user = await User.findById(input_id)
          var amount = input.slice(68,72)

          var input_payload = concat(
            write32(input_ch.nonce),
            methodMap('withdraw'),
            write32(id), // was it intended to current hub?
            amount
          )

          assert(nacl.sign.detached.verify(input_payload, input.slice(4, 68), input_user.pubkey), "Invalid signature")

          amount = amount.readUInt32BE()
          assert(input_ch.balance >= amount)

          input_ch.nonce += 1
          input_ch.balance -= amount
          // adding everything to the signer first
          signer.balance += amount

          await input_ch.save()

        }

        // 2. are there disputes?



        // 3. pay to outputs

        for(var i = 0; i<outputs.length;i++){

          var [userId, hubId, amount] = outputs[i]

          amount = readInt(amount)
          hubId = readInt(hubId)

          // is pubkey or id
          if(userId.length != 32) userId = readInt(userId)


          if(hubId == undefined){
            // standalone balance
  
            if(userId == signer.id){
              l("Can't settle to your own balance")
              continue
            }

            var user = await User.findOrBuild({
              where: (userId instanceof Buffer ? {pubkey: userId} : {id: userId})
            })
            user = user[0]



            l(user)

            if(user.id){
              // already exists
              user.balance += amount
              signer.balance -= amount

              l('Adding to existing user')
            }else if(userId.length == 32 && amount > K.account_creation_fee){
              user.fsb_balance = 0
              user.nonce = 0
              l("Created new user")

              user.balance = (amount - K.account_creation_fee)
              signer.balance -= amount

            }else{
              l('not enough to cover creation fee')
              
              continue
            }

            await user.save()

          }else{
            var ch = await Collateral.findOrBuild({
              where: {
                userId: userId,
                hubId: hubId,
                assetType: assetType
              },
              defaults:{
                nonce: 0,
                collateral: 0,
                settled: 0
              },
              include: { all: true }
            })

            ch[0].collateral += amount

            if(is_hub) ch[0].settled += amount
            signer.balance -= amount

            await ch[0].save()


          }

        }

        signer.save()

        break

      case 'voteApprove':
      case 'voteDeny':
        var vote = await Vote.findOrBuild({
          where: {
            userId: id,
            proposalId: args.slice(0, 4).readUInt32BE()
          }
        })
        vote = vote[0]
        vote.approval = method == 'voteApprove'

        await vote.save()
        l(`Voted ${vote.approval} for ${vote.proposalId}`)

        break


      }

      signer.save()

      return {success: true}
    }



    async getChannel(userId, hubId){
      if(hubId == 0){
        var wallet = await User.findOrBuild({
          where: {id: userId},
          defaults: {
            nonce: 0,
            balance: 0
          }
        })
      }else{
        var ch = await Collateral.findOrBuild({
          where: {
            userId: userId,
            hubId: hubId,
            assetType: 0
          },
          defaults:{
            nonce: 0,
            collateral: 0,
            settled: 0
          },
          include: { all: true }
        })

        var wallet = ch[0]
      }
      return wallet
    }





  async mint(assetType, userId, hubId, amount){
    var ch = await Collateral.findOrBuild({
      where: {
        userId: userId,
        hubId: hubId,
        assetType: 0
      },
      defaults:{
        nonce: 0,
        collateral: 0,
        settled: 0
      },
      include: { all: true }
    })

    ch.collateral += amount
    K.assets[assetType].total_supply += amount
    
    await ch.save()
  }



  async broadcast(method, args){
    var methodId = methodMap(method)

    me.record = await me.byKey()

    switch(method){
      case 'settle':
      case 'settleUser':


        break
      case 'propose':
        assert(args[0].length > 1, 'Rationale is required')

        if(args[2]){
          //diff -urB . ../yo
          args[2] = fs.readFileSync('../'+args[2])
        }

        args = r(args)
        break


      case 'voteApprove':
      case 'voteDeny':
        args = write32(args)
        break
    }

    // first is omitted parts, second is required
    var tx = me.sign(write32(me.record.nonce), concat(methodId, args))

    if(me.my_member && me.my_member == me.next_member){
      me.mempool.push(tx)
    }else{
      me.sendMember('tx', tx)
    }

    l("Just broadcasted ", tx)

    return tx;
  }


  // this is off-chain for any kind of p2p authentication
  // no need to optimize for bandwidth
  // so full pubkey is used instead of id and JSON is used as payload
  offchainAuth(){
    var msg = write32(ts())
    var to_sign = concat(write32(0), methodMap('auth'), msg )
    return concat(
      bin(this.id.publicKey),
      nacl.sign.detached(to_sign, this.id.secretKey),
      msg
    )

  }

  offchainVerify(token){
    var pubkey = token.slice(0,32)
    var sig = token.slice(32,96)
    var msg = token.slice(96)
    var to_sign = concat(write32(0), methodMap('auth'), msg)

    if(nacl.sign.detached.verify(to_sign, sig, pubkey)){
      l('verified success! ')
      return {
        signer: pubkey,
        data: msg
      }
    }else{
      return false
    }
  }



  /*
  Services are centralized servers that do some job for the network. Most common:
  Member (blockchain gatekeepers, they build and share blocks with others)
  Hub (faciliating mediated transfer with delayed settlement)
  Box storage
  message boards, App backends, etc.
  all Services must be end-to-end encrypted whenever possible

  Now all must be member as well to maintain the security of the network
  */

  // users
  // members - moderately trusted, average performance
  // hubs - highly trusted as compromises are painful, high performance

  async connect(){
    // in json pubkeys are in hex
    me.record = await me.byKey()

    l('initing mems')
    
    me.sendMember('auth', me.offchainAuth(), 0)
    

    me.members.map(c =>{
      c.block_pubkey = Buffer.from(c.block_pubkey, 'hex')
      //l(c.block_pubkey)
      if(me.record && me.record.id == c.id) me.my_member = c
    })

    if(me.my_member){

      for(var i = 0;i<me.members.length;i++){
        var c = me.members[i]
        if( me.my_member != c ){
          // we need to have connections ready to all members
          me.sendMember('auth', me.offchainAuth(), i)
        }
      }


      setInterval(()=>{
        var now = ts()

        var currentIndex = Math.floor(now / K.blocktime) % K.members.length
        me.current = me.members[currentIndex]

        var increment =  (K.blocktime - (now % K.blocktime)) < 10 ? 2 : 1

        me.next_member = me.members[ (currentIndex + increment) % K.members.length]

        //l(`Current member at ${now} is ${me.current.id}. ${me.status}`)

        if(me.my_member == me.current){
          // do we have enough sig or it's time?
          var sigs = []
          var total_shares = 0
          me.members.map((c, index)=>{
            if(c.sig){
              sigs[index] = bin(c.sig)
              total_shares+=c.shares
            }else{
              sigs[index] = Buffer.alloc(64)
            }
          })

          if(me.status == 'precommit' && (total_shares == K.members.length || now % K.blocktime > K.blocktime/2)){
            if(total_shares < K.majority){
              d(`Only have ${total_shares} shares, cannot build a block!`)
            }else{
              d('Lets process the finalblock we just built')
              
              me.processBlock(concat(
                Buffer.concat(sigs),
                me.precommit
              ))
            }
            // flush sigs
            me.members.map(c=>c.sig = false)

            me.status = 'await'


          }else if (me.status == 'await'){
            me.status = 'precommit'
            me.processMempool()
          }

        }else{
          me.status = 'await'
        }
      }, 2000)
    }


  }

  // we abstract away from Internet Protocol and imagine anyone just receives input out of nowhere
  // this input is of few different kinds:
  // it can be from member to another member to persist a socket between them
  // or it can be a new block received from another member to add a signature
  // or it can be a fully signed block to be applied
  // or a new tx from anyone to be added to block or passed to current member
  async processInput(ws, tx){
    // sanity checks 100kb
    if(tx.length > 100000){
      l(`too long input ${(tx).length}`)
      return false
    }

    // if it's another member, add ws to me.members
    // 32 pubkey + 64 sig + 4 of current time
    let obj, member

    var inputType = inputMap(tx[0])

    tx = tx.slice(1)

    l(inputType)


    if(inputType == 'auth' &&
      (obj = me.offchainVerify(tx)) &&
      (ts() - 100 < obj.data.readUInt32BE())
    ){
      l('Someone connected: '+toHex(obj.signer))

      wss.users[obj.signer] = ws

      var m = me.members.find(f=>f.block_pubkey.equals(obj.signer))
      if(m){
        m.socket = ws 
      }

      return false
    }else if (inputType == 'tx'){

      // 2. is it us?
      if(me.my_member && me.my_member == me.next_member){
        l('We are next, adding to mempool')
        me.mempool.push(tx)
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
      if(m && nacl.sign.detached.verify(block, sig, pubkey)  ){
        l(`${m.id} asks us to sign their block!`)

        var signed = concat(
          inputMap('signed'),
          bin(me.id.publicKey),
          nacl.sign.detached(block, me.id.secretKey)
        )
        m.socket.send(signed)
      }

      // a member needs your signature


    }else if (inputType == 'signed'){
      var [pubkey, sig, block] = r(tx)

      var m = me.members.find(f=>f.block_pubkey.equals(pubkey) )

      assert(me.status == 'precommit', 'Not expecting any sigs')

      if(m && nacl.sign.detached.verify(me.precommit, sig, pubkey)){
        m.sig = sig
        //l(`Received another sig from  ${m.id}`)
      }else{
        l("this sig doesn't work for our block")
      }



    }else if (inputType == 'block'){
      await me.processBlock(tx)
    }else if (inputType == 'chain'){
      var chain = r(tx)
      for(var i = 0;i<chain.length;i++){
        l(' processing chain with '+i)
        await me.processBlock(chain[i])
      }
    }else if (inputType == 'sync'){

      var last = await Block.findOne({where: {
        prev_hash: tx
      }})
      var start = last ? last.id : 1

      l("Sharing blocks since "+start)

      Block.findAll({
        where: {
          id: {[Sequelize.Op.gte]: start}
        }
      }).then(async blocks=>{ 
        ws.send(concat(inputMap('chain'), r(blocks.map(b=>b.block)) ))

      })

    }else if (inputType == 'mediate'){
      var [delta, to] = r(tx)
      l("Mediating transfer to ", delta, to)



      if(wss.users[to]){
        wss.users[to].send(concat(
          inputMap('receive'),
          me.sign(to, r([
            123

            ]))
        ))

      }else{
        l('no ws to that user')

      }

    }else if (inputType == 'receive'){
  
      //nacl.sign.detached.verify
       
      l("Received ", tx)

      let delta = await Delta.findOrBuild({
        where: {
          counterpartyId: 1
        }, defaults: {
          delta: 0
        }
      })

      delta[0].delta += 123

      await delta[0].save


    }

  }


  async channel(counterparty){
    var r = {
      collateral: 0,
      delta: 0,
      failsafe: 0,
      total: 0
    }

    if(me.my_member && me.my_member.is_hub){

    }else{
      if(me.record){
        var ch = await Collateral.find({where: {
          userId: me.record.id,
          hubId: counterparty
        }})

        if(ch) r.collateral = ch.collateral
      }

      var delta = await Delta.find({
        where: {
          hubId: 1,
          userId: bin(me.id.publicKey)
        }
      })
      if(delta) r.delta = delta.delta

      r.total = r.collateral + r.delta

      if(r.delta >= 0){
        r.failsafe = r.collateral
      }else{
        r.failsafe = r.collateral + r.delta
      }


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

      }else if(nacl.sign.detached.verify(finalblock, sig, me.members[i].block_pubkey)){
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

    block_number = block_number.readUInt32BE()
    methodId = methodMap(methodId.readUInt32BE())
    timestamp = timestamp.readUInt32BE()
    prev_hash = prev_hash.toString('hex')

    assert(methodId == 'block', 'Wrong method for block')
    assert(finalblock.length <= K.blocksize, 'Invalid block')
    assert(timestamp > K.ts, 'New block from the past')


    if(K.prev_hash != prev_hash){
      l(`Must be based on ${K.prev_hash} but is using ${prev_hash}`)
      return false
    }

    d(`Processing ${block_number} (before ${K.total_blocks}) hash ${K.prev_hash}. Timestamp ${timestamp} Total shares: ${total_shares}, tx to process: ${ordered_tx.length}`)

    // processing transactions one by one
    for(var i = 0;i<ordered_tx.length;i++){
      await me.processTx(ordered_tx[i])
      K.total_tx++
    }


    K.ts = timestamp
    K.prev_hash = toHex(sha3(finalblock))

    K.total_blocks++
    if(finalblock.length < K.blocksize-1000){
      K.usable_blocks++
    }



    const to_execute = await Proposal.findAll({where: {delayed: K.usable_blocks}})
    
    //l("Processing delayed jobs "+to_execute.length)
    
    for(let job of to_execute){
      job = r(job.change)

      l(toUTF(job[0]))

      l(toUTF(job[1]))
      await eval(toUTF(job[1]))

      var patch = toUTF(job[2])
      l(patch)
      if(patch.length > 0){
        me.request_reload = true
        var pr = require('child_process').exec('patch -p1', (error, stdout, stderr) => {
            console.log(error, stdout, stderr);
        });
        l('Patch time!')
        pr.stdin.write(patch)
        pr.stdin.end()

      }


    }


    K.total_bytes += block.length
    K.bytes_since_last_snapshot+=block.length

    // every x blocks create new installer
    if(K.bytes_since_last_snapshot > K.snapshot_after_bytes){
      K.bytes_since_last_snapshot = 0
      K.last_snapshot_height = K.total_blocks
    }else{

    }
    if(K.total_blocks % 100 == 0){
      // increase or decrease bandwidth tax per byte
    }

    fs.writeFileSync('data/k.json', stringify(K))

    if(K.bytes_since_last_snapshot == 0){
      trustlessInstall()
    }


    // save final block in blockchain db and broadcast
    if(me.my_member){
      Block.create({
        prev_hash: Buffer.from(prev_hash, 'hex'),
        hash: sha3(finalblock),
        block: block
      })

      var blocktx = concat(inputMap('block'), block)
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
        me.processInput(m.socket,tx)
      }

      m.socket.onopen = function(e){
        l("Sending to member ", tx)
        m.socket.send(tx)
      }

      m.socket.open('ws://'+m.location)
    }


  
  }

}

module.exports = [Me]



