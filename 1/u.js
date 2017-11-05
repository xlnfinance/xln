secp256k1 = require("secp256k1");
E = require("ethereumjs-util");
assert = require("assert");
crypto = require("crypto");
WebSocket = require("ws");
fs = require("fs");
request = require("request");
http = require("http");
nacl = require('tweetnacl')



Sequelize = require('sequelize');
Op = Sequelize.Op;

wenet_port = 8000
blocksize = 1048576

l = console.log
toHex = (inp) => Buffer.from(inp).toString('hex')
bin=(data)=>Buffer.from(data)
ts = () => Math.round(new Date/1000)

wed = d => d * 100 // We dollars to cents

toUTF = (inp) => Buffer.from(inp).toString()


fromHex = hex => new Buffer(hex, "hex");
odd = int => int % 2 == 1;
concat = function() {
  return Buffer.concat(Object.values(arguments));
}

write32 = (int) => {
  var b = Buffer.alloc(4)
  b.writeUInt32BE(int)
  return b
}



// used just for convenience in parsing
inputMap = (i)=>{
  // up to 256 input types for websockets
  var map = ['tx', 'auth', 'needSig', 'signed', 'block', 'chain', 'sync']
  if(typeof i == 'string'){
    // buffer friendly
    return Buffer([map.indexOf(i)])
  }else{
    return map[i]
  }
}

// enumerator of all methods and tx types in the system
methodMap = (i)=>{
  var map = [
    'block',

    'settle',
    'settleUser',

    'withdraw', // instant off-chain signature to withdraw from mutual payment channel

    'addProposal',
    'voteApprove',
    'voteDeny',

    'auth' // any kind of off-chain auth signatures between peers
  ]
  if(typeof i == 'string'){
    // buffer friendly
    assert(map.indexOf(i) != -1, "No such method")
    return write32(map.indexOf(i))
  }else{
    return map[i]
  }
}


allowedOnchain = [
  'settle',
  'settleUser',
  'addProposal',
  'voteApprove',
  'voteDeny',
]



class Me {
  async init(username, pw) {
    this.username = username
    this.pw = E.sha3(pw) // we only store checksum for doublechecks

    this.seed = await derive(username,pw)
    this.id = nacl.sign.keyPair.fromSeed(this.seed)
    this.id.publicKey = bin(this.id.publicKey)

    this.mempool = []
    this.state = 'await'


    this.sockets = {}
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

    l("Parsed tx", parsedTx)

    return parsedTx
  }

  async processMempool(){
    var ordered_tx = []
    var total_size = 0

    var pseudo_balances = {}

    for(var i = 0;i < me.mempool.length;i++){
      var tx = me.mempool[i]

      if(total_size + tx.length > blocksize) break;

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



    var block_number = await K.total_blocks
    block_number++
    //await (K.total_blocks = block_number)
    var prev_hash = await K.prev_hash
    // block has current height, hash of prev block , ts()

    me.precommit = E.rlp.encode([
      write32(block_number),
      methodMap('block'),
      Buffer.from(prev_hash, 'hex'),
      write32(ts()),
      ordered_tx
    ])

    var myCoord = me.coordinators.find(f=>this.id.publicKey.equals(f.pubkey))

    myCoord.sig = nacl.sign.detached(me.precommit, this.id.secretKey)

    var needSig = concat(
      inputMap('needSig'),
      bin(this.id.publicKey),
      myCoord.sig,
      me.precommit
    )

    me.coordinators.map((c)=>{
      if(c.socket)
      c.socket.send(needSig)
    })

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
    // btc in 2017 fee is 0.5 cents per byte
    // that seems fair price for bugging the whole world about your tx
    var tax = Math.round(0.1 * tx.length)

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



    l(`ProcessTx: ${method} with ${args.length}`)
    // Validation is over, fee is ours
    signer.balance -= tax
    signer.nonce += 1
    //signer.save()


    switch(method){
      case 'proposeCoordinator':
      case 'proposeHub':
      case 'proposeDiff':
      case 'proposeCommand':
      case 'addProposal':
        var execute_on = await K.usable_blocks + 60*24
        var new_proposal = await Proposal.create({
          change: toUTF(args),
          cron: execute_on
        })
        l(`Added ${new_proposal.change} proposal!`)

        break
      // don't forget BREAK
      // we use fall-through for methods covered by same code
      // settle uses relative user_id, settleUser uses absolute hub_id
      case 'settle':
      case 'settleUser':
        // 1. collect all inputs from the channels to this node
        var input_len = 76 // id sig amount
        var start = 1

        var is_hub = (method == 'settle')

        for(var i=0;i<args[0];i++){
          // get withdrawal tx
          var start = 1+i*input_len
          var input = tx.slice(start, start+input_len)

          // you can't withdraw  from non existant channel
          var input_id = input.slice(0, 4).readUInt32BE()
          var input_ch = await Channel.find({
            where: {
              userId: is_hub ? input_id : id,
              hubId: is_hub ? id : input_id,
              kindof: 0
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

        // 2. are there unsettled channels?

        // 3. pay to outputs
        var start = 2+i*input_len
        var outputs_num = args[start]
        for(var i = 0;i<outputs_num;i++){
          var output_id = args.slice(start, start+=4).readUInt32BE()

          // settle is relative and uses current hub. settleUser is absolute
          var hub_id = is_hub ? id : args.slice(start, start+=4).readUInt32BE()

          var output_amount = args.slice(start, start+=4).readUInt32BE()

          assert((hub_id != 0 || output_id != id), 'No need to explicitly set your node id')
          assert(signer.balance >= output_amount, 'Not enough funds to fill this output')

          var ch = await this.getChannel(output_id, hub_id)
          ch.balance += amount
          if(is_hub){
            // hubs increase how much they settled, users don't
            ch.settled += amount
          }
          ch.save()
        }

        signer.save()

        break

      case 'addBalance':
        var userId = args.slice(0, 4).readUInt32BE()
        var hubId = args.slice(4, 8).readUInt32BE()
        var amount = args.slice(8, 12).readUInt32BE()

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



    async getChannel(user_id, hub_id){
      var ch = await Channel.findOrBuild({
        where: {
          userId: user_id,
          hubId: hub_id,
          kindof: 0
        },
        defaults:{
          nonce: 0,
          balance: 0,
          settled: 0
        },
        include: { all: true }
      })

      return ch[0]
    }

    // masked_id will be added later
    async pay(recipient_id, hub_ids, amount){

      var ch = await me.getChannel(me.record.id, recipient_id)

      assert(amount <= ch.balance, "Not enough money in channel")

      return me.sign(concat(
        write32(ch.nonce),
        methodMap('withdraw'),
        write32(recipient_id) // hub id
      ), write32(amount))
    }





  async addBalance(userId, hubId, amount){
    if(hubId == 0){
      var wallet = await User.findOrBuild({
        where: {id: userId},
        defaults: {
          nonce: 0,
          balance: 0
        }
      })
    }else{
      var wallet = await this.getChannel(userId, hubId)
    }

    wallet.balance += amount
    wallet.save()
    return wallet
  }




  async broadcast(method, args){
    var methodId = methodMap(method)

    me.record = await me.byKey()

    switch(method){
      case 'settle':
      case 'settleUser':

        //len, inputs, len, outputs

        //args.inputs.length
        //args.outputs.length

        break
      case 'addProposal':
        args = bin(args)
        break

      case 'voteApprove':
      case 'voteDeny':
        args = write32(args)
        break
    }

    // first is omitted parts, second is required
    var tx = me.sign(write32(me.record.nonce), concat(methodId, args))

    me.findNearest(concat(inputMap('tx'),tx))

    return tx;
  }


  // this is off-chain for any kind of p2p authentication
  // no need to optimize for bandwidth
  // so full pubkey is used instead of id and JSON is used as payload
  offchainAuth(msg){
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
  There are different types of WeOS Services.
  Services are centralized servers that do some job for the network. Most common:
  Coordinator (blockchain gatekeepers, they build and share blocks with others)
  Hub (faciliating mediated transfer with delayed settlement)
  Box storage (stores WeOS boxes for a fee)
  message boards, App backends, etc.
  all Services must be end-to-end encrypted whenever possible

  Now all must be Coordinators as well to maintain the security of the network
  */

  // users - not trusted at all
  // coordinators, run by oracles - moderately trusted, average performance
  // hubs, run by architects - highly trusted as compromises are painful, high performance

  async initCoordinator(){
    // each coordinator must have bidirectional sockets ready to all other coordinators
    me.record = await me.byKey()

    for(var i = 0;i<me.coordinators.length;i++){
      var c = me.coordinators[i]
      if(me.id.publicKey.equals(c.pubkey) ){
        var [host, port] = c.location.split(':')

        me.external_wss = new WebSocket.Server({ host: host, port: port });
        me.external_wss.users = []
        me.external_wss.on('connection', function(ws) {
          ws.on('message', tx=>{me.processInput(ws,tx)});
        });
      }else{
        c.socket = new WebSocketClient();
        c.socket.onopen = function(e){
          var auth = me.offchainAuth(write32(ts()))

        	this.send( concat( inputMap('auth'), auth) )
        }
        c.socket.onmessage = tx=>{me.processInput(c.socket,tx)}

        c.socket.open('ws://'+c.location)

      }
    }
  }

  // we abstract away from Internet Protocol and imagine anyone just receives input out of nowhere
  // this input is of few different kinds:
  // it can be from coordinator to another coordinator to persist a socket between them
  // or it can be a new block received from another coordinator to add a signature
  // or it can be a fully signed block to be applied
  // or a new tx from anyone to be added to block or passed to current coordinator
  async processInput(ws, tx){
    // sanity checks 100kb
    if(tx.length > 100000 || tx.length < 10){
      l(`invalid input ${tx}`)
      return false
    }


    // if it's another coordinator, add ws to me.coordinators
    // 32 pubkey + 64 sig + 4 of current time
    let obj, coordinator

    var inputType = inputMap(tx[0])

    tx = tx.slice(1)


    if(inputType == 'auth' &&
      (obj = me.offchainVerify(tx)) &&
      (obj.c = me.coordinators.find(f=>f.pubkey.equals(obj.signer))) &&
      (ts() - 100 < obj.data.readUInt32BE())
    ) {
      l('Another coordinator connected: '+toHex(obj.signer))
      obj.c.socket = ws
      return false
    }else if (inputType == 'tx'){

      // 2. is it us?
      if(me.id.publicKey.equals(me.next_coordinator.pubkey)){
        l('We are next, adding to mempool')
        me.mempool.push(tx)
      }else{
        if(me.next_coordinator.socket){
          l('passing to next '+me.next_coordinator.id)
          me.next_coordinator.socket.send(concat(inputMap('tx'),tx))
        }else{
          l('No active socket to current coordinator: '+me.next_coordinator.id)
        }

      }
    }else if (inputType == 'needSig'){
      var coord = me.coordinators.find(f=>f.pubkey.equals(tx.slice(0,32)) )
      var sig = tx.slice(32,96)
      var block = tx.slice(96)

      // ensure the block is non repeating

      if(coord && nacl.sign.detached.verify(block, sig, tx.slice(0,32))  ){
        l(`${coord.id} asks us to sign their block!`)

        var signed = concat(
          inputMap('signed'),
          bin(me.id.publicKey),
          nacl.sign.detached(block, me.id.secretKey)
        )

        coord.socket.send(signed)
      }

      // a coordinator needs your signature


    }else if (inputType == 'signed'){
      var coord = me.coordinators.find(f=>f.pubkey.equals(tx.slice(0,32)) )
      var sig = tx.slice(32,96)

      assert(me.state == 'precommit', 'Not expecting any sigs')

      if(coord && nacl.sign.detached.verify(me.precommit, sig, tx.slice(0,32))){
        coord.sig = sig
        //l(`Received another sig from  ${coord.id}`)
      }else{
        l("this sig doesn't work for our block")
      }



    }else if (inputType == 'block'){
      await me.processBlock(tx)
    }else if (inputType == 'chain'){
      var chain = E.rlp.decode(tx)
      for(var i = 0;i<chain.length;i++){
        l(' processing chain with '+i)
        await me.processBlock(chain[i])
      }
    }else if (inputType == 'sync'){
      me.external_wss.users.push(ws)
      var last = await Block.findOne({where: {
        prev_hash: tx
      }})
      var start = last ? last.id : 1

      l("Sharing blocks since "+start)

      Block.findAll({
        where: {
          id: { $gte: start}
        }
      }).then(async blocks=>{
        ws.send(concat(inputMap('chain'), E.rlp.encode(blocks.map(b=>b.block)) ))

      })

    }
  }

  async processBlock(block){

    var finalblock = block.slice(me.coordinators.length * 64)

    l(`Processing a new block, length ${block.length}`)

    var missed_sigs = 0
    var valid_sigs = 0

    for(var i = 0;i<me.coordinators.length;i++){
      var sig = (block.slice(i * 64, (i+1) * 64))

      if(sig.equals(Buffer.alloc(64))){
        missed_sigs++
      }else if(nacl.sign.detached.verify(finalblock, sig, me.coordinators[i].pubkey)){
        valid_sigs++
      }else{
        l(`Invalid signature for a given block. Halt!`)
        return false
      }


    }

    if(valid_sigs < 4){
      l("Not enough valid sigs on a block")
      return false
    }


    var [block_number,
      methodId,
      prev_hash,
      timestamp,
      ordered_tx] = E.rlp.decode(finalblock)

    block_number = block_number.readUInt32BE()
    methodId = methodMap(methodId.readUInt32BE())
    timestamp = timestamp.readUInt32BE()
    prev_hash = prev_hash.toString('hex')

    assert(methodId == 'block', 'Wrong method for block')

    var expected_prev_hash = (await K.prev_hash)
    assert(expected_prev_hash == prev_hash, "Must be based on "+expected_prev_hash+' but is using '+prev_hash)

    var new_hash = toHex(E.sha3(finalblock))
    K.prev_hash = new_hash

    var expected_block = (await K.total_blocks) + 1

    l(`Processing ${block_number} (${expected_block}) hash ${new_hash}. Timestamp ${timestamp} Valid: ${valid_sigs}, missed: ${missed_sigs}, tx to process: ${ordered_tx.length}`)

    await (K.total_blocks = block_number)

    if(finalblock.length < blocksize-1000){
      var usable_blocks = await K.usable_blocks
      await (K.usable_blocks = usable_blocks+1)
    }




    for(var i = 0;i<ordered_tx.length;i++){
      await me.processTx(ordered_tx[i])
    }

    // save final block in blockchain db
    Block.create({
      prev_hash: Buffer.from(expected_prev_hash, 'hex'),
      hash: E.sha3(finalblock),
      block: block
    })

    var blocktx = concat(inputMap('block'), block)
    // send finalblock to all websocket users if we're coordinator
    if(me.external_wss){
      me.external_wss.users.forEach(client=>client.send(blocktx))
    }


  }



  findNearest(tx){
    // connecting to geo-selected nearest coordinator (lowest latency)
    if(me.nearest){
      if(tx) me.nearest.send(tx)
    }else{
      var randomCoordinator = me.coordinators[Math.floor(Math.random() * me.coordinators.length)]
      me.nearest = new WebSocketClient();
      me.nearest.open('ws://'+randomCoordinator.location)

      me.nearest.onmessage = tx=>{me.processInput(me.nearest,tx)}

      me.nearest.onopen = function(e){
        if(tx) me.nearest.send(tx)
      }

    }
  }





}

/*


tar --exclude=./private -zcf ../weos.tar.gz .

shasum -a 256 weos.tar.gz

mkdir u3 && tar -zxf weos.tar.gz -C ./u3

shasum -b -a 256 data/db.sqlite


cp u1


  shasum = crypto.createHash('sha256')
  s = fs.ReadStream('./data/db.sqlite')
  s.on('data', function(data) {
    shasum.update(data)
  })
  s.on('end', function() {
    console.log(shasum.digest('hex'))
  })

*/

var sys = require('sys')
var exec = require('child_process').exec;
var child;



trustlessInstall = async a=>{
  tar = require('tar')
  var blocks = await K.total_blocks
  var filename = 'WeOS-'+blocks+'-'+me.username+'.tar.gz'

  tar.c({
      gzip: true,
  		portable: true,
      file: '../'+filename,
      filter: (path,stat)=>{
        if(['./data/db.leveldb/LOCK','./data/db.leveldb/LOG'].indexOf(path) != -1) return false;

        return true;
      }
    },
    ['.']
  ).then(_=>{
    var sys = require('sys')
    var exec = require('child_process').exec;
    exec("shasum -a 256 ../"+filename, async (er,out,err)=>{
      me.record = await me.byKey()
      var out_hash = out.split(' ')[0]
      var host = me.myCoordinator.location.split(':')[0]
      var install_port = 1114
      var out_location = 'http://'+host+':'+install_port+'/'+filename
l(`
# Compare the snippet with other sources, and if exact match paste into Terminal.app

folder=2
mkdir $folder && cd $folder;
wget ${out_location}
if shasum -a 256 ${filename} | grep ${out_hash}; then
echo "Installing...";
tar -xzf ${filename};
node-v8.9.0-darwin-x64/bin/node u.js $folder
fi`)
      var serv = http.createServer(function (req, res) {
        if(req.url != '/'+filename){
          res.status(404)
          res.end('None')
          return false
        }
          var stat = fs.statSync('../'+filename);
          res.writeHeader(200, {"Content-Length": stat.size});
          var fReadStream = fs.createReadStream('../'+filename);
          fReadStream.on('data', function (chunk) {
             if(!res.write(chunk)){
                 fReadStream.pause();
             }
         });
         fReadStream.on('end', function () {
            res.end();
         });
         res.on("drain", function () {
            fReadStream.resume();
         });
      });

      serv.listen(install_port);

    });

  })

}


originAllowence = {
  'null': 400,
  'http://127.0.0.1:8000': 500
}



function WebSocketClient(){
	this.number = 0;	// Message number
	this.autoReconnectInterval = 5*1000;	// ms
}
WebSocketClient.prototype.open = function(url){
	this.url = url;
	this.instance = new WebSocket(this.url);
	this.instance.on('open',()=>{
		this.onopen();
	});
	this.instance.on('message',(data,flags)=>{
		this.number ++;
		this.onmessage(data,flags,this.number);
	});
	this.instance.on('close',(e)=>{
		switch (e){
		case 1000:	// CLOSE_NORMAL
			console.log("WebSocket: closed");
			break;
		default:	// Abnormal closure
			this.reconnect(e);
			break;
		}
		this.onclose(e);
	});
	this.instance.on('error',(e)=>{
		switch (e.code){
		case 'ECONNREFUSED':
			this.reconnect(e);
			break;
		default:
			this.onerror(e);
			break;
		}
	});
}
WebSocketClient.prototype.send = function(data,option){
	try{
		this.instance.send(data,option);
	}catch (e){
		this.instance.emit('error',e);
	}
}
WebSocketClient.prototype.reconnect = function(e){
	//console.log(`WebSocketClient: retry in ${this.autoReconnectInterval}ms`);
        this.instance.removeAllListeners();
	var that = this;
	setTimeout(function(){
    var connected = 0
    me.coordinators.map(o=>{if(o.socket) connected++})
		//console.log("WebSocketClient: reconnecting... Have "+connected);
		that.open(that.url);
	},this.autoReconnectInterval);
}
WebSocketClient.prototype.onopen = function(e){
  console.log("WebSocketClient: open",arguments);
}
WebSocketClient.prototype.onmessage = function(data,flags,number){	//console.log("WebSocketClient: message",arguments);
}
WebSocketClient.prototype.onerror = function(e){
  console.log("Couldn't reach"+e.port);
}
WebSocketClient.prototype.onclose = function(e){	console.log("WebSocketClient: closed",arguments);	}


initDashboard=a=>{

  var finalhandler = require('finalhandler');
  var serveStatic = require('serve-static');

  var whitelist_hosts = ['127.0.0.1:'+wenet_port, '0.0.0.0:'+wenet_port]

  // this serves dashboard HTML page
  var server = http.createServer(function(req, res) {
    console.log(req.headers)
    // only allow downloading before
    assert(isLocalhost(req.connection.remoteAddress), 'Must be coming from localhost IP')
    assert(whitelist_hosts.indexOf(req.headers.host)!=-1, 'DNS rebinding attack')

    res.statusCode = 200;
    var app_name = req.headers.host.match(/([a-z]+)\.we(:[0-9]+)?/)
    if(app_name){
      console.log("serving ./apps/"+app_name[1]);

      serveStatic("./apps/"+app_name[1])(req, res, finalhandler(req, res));
    }else{
      serveStatic("./apps/gov")(req, res, finalhandler(req, res));
    }
    //res.setHeader('Access-Control-Allow-Origin', '*');
    //res.setHeader('Content-Type', 'text/html');
  });

  console.log('Set up HTTP server at '+wenet_port)
  server.listen(wenet_port);

  me.internal_wss = new WebSocket.Server({ port: 8084 });
  console.log('Set up websocket server to accepts local commands')
  me.internal_wss.on('connection', function(ws,req) {
    console.log('ws', req.headers)
    // Origin = our proxy, and initiated by this device
    assert(isLocalhost(req.connection.remoteAddress), 'Must be coming from localhost IP')
    assert(req.headers.host == '127.0.0.1:8084', 'DNS rebinding attack')
    assert(whitelist_hosts.indexOf(req.headers.origin)!=-1, 'DNS rebinding attack')

    ws.send('{"id":0}')

    ws.on('message', msg=>{
      json = JSON.parse(msg)

      if(json.method == 'pay'){
        // some Origins are whitelisted for Smooth Payments
        if(json.confirmed || originAllowence[json.proxyOrigin] >= json.params.amount){

          //me.pay('')

          originAllowence[json.proxyOrigin] -= json.params.amount

          ws.send(JSON.stringify({
            status: 'paid',
            id: json.id
          }))

        }else{
          // request explicit confirmation
          json.confirmation = true
          ws.send(JSON.stringify(json))
        }

      } else if (json.method == 'login'){
        // Smooth Login
        var token = JSON.stringify([json.proxyOrigin, me.seed])

        ws.send(JSON.stringify({
          token: toHex(E.sha3(token)),
          id: json.id
        }))



      }
    })


  });


  require('./opn')('http://0.0.0.0:'+wenet_port)

}

isLocalhost=(ip)=>{
  return ['127.0.0.1', '::ffff:127.0.0.1', '::1'].indexOf(ip) != -1 || ip.indexOf('::ffff:127.0.0.1:') == 0
}

derive = async (username, pw)=>{
  var pk = await require('scrypt').hash(pw, {
    N: Math.pow(2, 12),
    interruptStep: 1000,
    p: 1,
    r: 8,
    dkLen: 32,
    encoding: 'base64'
  }, 32, username)

  l(`Derived ${pk.toString('hex')} for ${username}:${pw}`)

  return pk;
}



process.on('unhandledRejection', r => console.log(r))

K = []

main = async (username, login)=>{
  // define db

  sequelize = new Sequelize(username, username, 'password', {
    dialect: 'sqlite',
    storage: 'data/db.sqlite'
  });


  //sequelize = new Sequelize('postgres://homakov:@localhost:5432/dbname');

  opts = {
    timestamps: false
  }

  // two kinds of storage: 1) critical database that might be used by code
  // 2) complementary stats like updatedAt that's useful in exploring and can be deleted safely

  User = sequelize.define('user', {
    username: Sequelize.STRING,
    pubkey: Sequelize.CHAR(32).BINARY,

    nonce: Sequelize.INTEGER,
    balance: Sequelize.BIGINT // mostly to pay taxes

  }, opts);

  Proposal = sequelize.define('proposal', {

    change: Sequelize.TEXT,

    cron: Sequelize.INTEGER,
    kindof: Sequelize.CHAR(1).BINARY
  }, opts)

  Proposal.belongsTo(User);

  Channel = sequelize.define('channel', {
    nonce: Sequelize.INTEGER, // for instant withdrawals
    balance: Sequelize.BIGINT, // collateral
    settled: Sequelize.BIGINT, // what hub already collateralized
    kindof: Sequelize.CHAR(1).BINARY,

    cron: Sequelize.INTEGER
    // dispute has last nonce, last agreed_balance
  }, opts)

  //me.record.addHub(x, { through: { type: 'channel' }});
  User.belongsToMany(User, {through: Channel, as: 'hub'});

  Vote = sequelize.define('vote', {
    rationale: Sequelize.TEXT,
    approval: Sequelize.BOOLEAN // approval or denial
  }, opts)

  User.belongsToMany(Proposal, {through: Vote, as: 'voter'});


  Block = sequelize.define('block', {
    block: Sequelize.CHAR.BINARY,
    hash: Sequelize.CHAR(32).BINARY,
    prev_hash: Sequelize.CHAR(32).BINARY
  }, opts)


  db = require('level')('data/db.leveldb')

  K = new Proxy(K, {
    get: async function(target, name) {
      try{
        var result = await db.get(name)
        result = JSON.parse(result)
      }catch(e){return false }
      return result
    },
    set: async function(target, name, val){
      return await db.put(name, JSON.stringify(val))
    }
  })


  if(login){
    me = new Me
    await me.init(username, 'password')
    me.record = await me.byKey()

    me.coordinators = await K.coordinators


    // in json pubkeys are in hex
    me.coordinators.map(c => c.pubkey = Buffer.from(c.pubkey, 'hex'))


    me.myCoordinator = me.coordinators.find(f=>me.id.publicKey.equals(f.pubkey))


    var prev_hash = await K.prev_hash
    me.findNearest(concat(inputMap('sync'), Buffer.from(prev_hash, 'hex')) )


    // am I coordinator?
    if(me.myCoordinator){
      me.initCoordinator()

      setInterval(()=>{
        var now = ts()
        var period = 60
        var total = 7
        var currentIndex = Math.floor(now / period) % total
        me.current = me.coordinators[currentIndex]

        var nextIndex = currentIndex + ((now % period > 50) ? 2 : 1)

        me.next_coordinator = me.coordinators[nextIndex % total]

        //l(`Current coordinator at ${now} is ${me.current.id}. Our state ${me.state}`)

        if(me.id.publicKey.equals(me.current.pubkey)){
          // do we have enough sig or it's time?
          var sigs = []
          var missed = 0
          me.coordinators.map((c, index)=>{
            if(c.sig){
              sigs[index] = bin(c.sig)
            }else{
              sigs[index] = Buffer.alloc(64)
              missed++
            }
            c.sig = false
          })

          if(me.state == 'precommit' && (missed == 0 || now % period > 30)){
            if(missed > 4){
              l(`Missed ${missed} sigs, cannot build a block!`)
            }else{

              var finalblock = concat(
                inputMap('block'),
                Buffer.concat(sigs),
                me.precommit
              )


              me.coordinators.map((c)=>{
                if(c.socket){
                  c.socket.send(finalblock)
                }
              })

              l('Lets process the finalblock we just built')
              me.processBlock(concat(
                Buffer.concat(sigs),
                me.precommit
              ))

            }

            me.state = 'commit'

          }else if (me.state == 'await'){
            me.state = 'precommit'
            me.processMempool()
          }

        }else{
          me.state = 'await'
        }


      }, 1000)
    }
  }

}

yo = ()=>{
  me.broadcast('addProposal', 'yo')
}

genesis = async ()=>{
  //await(fs.rmdir('data'))
  await(fs.mkdir('data'))
  var u = []
  var coords = []
  await (main('u1'))
  await (sequelize.sync({force: true}))

  for(var i = 1; i < 21;i++){
    u[i] = new Me;
    var username = "u"+i
    //fs.mkdir('data/'+username)

    await (u[i]).init(username,'password');


    var user = await (User.create({
      pubkey: bin(u[i].id.publicKey),
      username: username,
      nonce: 0,
      balance: 100000
    }))

    if(i<8){
      coords.push({
        id: user.id,
        pubkey: bin(u[i].id.publicKey).toString('hex'),
        location: '0.0.0.0:'+(8020+i),
        missed_blocks: []
      })
    }
    coords[0].is_hub = 1
  }

  await (K.total_blocks = 0)
  await (K.usable_blocks = 0)
  await (K.prev_hash = toHex(Buffer.alloc(32)))
  await (K.coordinators = coords)


  for(var i = 2; i < 21;i++){
    //require("fs-extra").copy('./data/u1.leveldb', './data/u'+i+'.leveldb')
    //require("fs-extra").copy('./data/u1.sqlite', './data/u'+i+'.sqlite')
  }

}



if(process.argv[2] == 'genesis'){
  genesis()
}else{
  var username = 'u' + (process.argv[2] ? parseInt(process.argv[2]) : 1)
  main(username, true)




  function preprocess(input) {
    const awaitMatcher = /^(?:\s*(?:(?:let|var|const)\s)?\s*([^=]+)=\s*|^\s*)(await\s[\s\S]*)/;
    const asyncWrapper = (code, binder) => {
      let assign = binder ? `global.${binder} = ` : '';
      return `(function(){ async function _wrap() { return ${assign}${code} } return _wrap();})()`;
    };
    const match = input.indexOf('await') != -1;
    if (match) {
      input = `${asyncWrapper(match[2], match[1])}`;
    }
    return input;
  }


  const replInstance = require('repl').start({ prompt: '> ' });
  const _eval = replInstance.eval;

  replInstance.eval = (cmd, context, filename, callback)=>{
    _eval(preprocess(cmd), context, filename, callback);
  }
  //.bind(this);





}











// debug REPL .load u.js
//require('repl').start({useGlobal: true})
