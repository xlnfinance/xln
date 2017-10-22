secp256k1 = require("secp256k1");
E = require("ethereumjs-util");
assert = require("assert");
crypto = require("crypto");
WebSocket = require("ws");
fs = require("fs");
request = require("request");
http = require("http");
nacl = require('tweetnacl')



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



const onchainMethods = [
'settle',
'eval'

]

class Me {
  constructor(username, pw) {
    this.username = username
    this.pw = E.sha3(pw) // we only store checksum for doublechecks
    derive(username,pw).then(seed => {
      this.id = nacl.sign.keyPair.fromSeed(seed)
      this.seed = seed;

      // setting current user
      me.byKey().then(r => this.record = r)
    })
  }

  async byKey(pk){
    if(!pk) pk = this.id.publicKey
    return await User.findOne({
      where: { pubkey: bin(pk) }
    })
  }





  sign(omitted_buf, payload) {
    var sig = nacl.sign.detached(concat(omitted_buf, payload), this.id.secretKey);

    // get id for my pubkey and store as big endian in a buffer
    // return detached id sig
    return concat(write32(this.record.id), sig, payload)
  }

  parseTx(tx){
    l(`parsing ${tx.length}`)
    return {
      id: tx.slice(0, 4).readUInt32BE(),
      sig: tx.slice(4, 68),
      methodId: tx.slice(68, 72).readUInt32BE(),
      args: tx.slice(72, tx.length)
    }
  }

  async processTx(tx) {
    var {id, sig, methodId, args} = me.parseTx(tx);

    var signer = await User.findById(id)

    // total tax is a sum of
    // size tax is for consuming bandwidth (all tx)

    // btc in 2017 fee is 0.5 cents per byte
    // that seems fair price for bugging the whole world about your tx
    var tax = Math.round(0.5 * tx.length)

    // gas tax is for consuming computational resources (optional)
    // storage tax is consumed both monthly and

    assert(signer.balance >= tax, "Not enough balance to cover tx fee")

    assert(onchainMethods.hasOwnProperty(methodId), 'No such method exposed onchain')

    // we prepend omitted vars to not bloat tx size
    var payload = concat(write32(signer.nonce), write32(methodId), args)
    assert(nacl.sign.detached.verify(payload, sig, signer.pubkey), "Invalid signature")

    // Validation is over, fee is ours

    var method = onchainMethods[methodId]

    switch(method){
      case 'settle':
        // 1. collect all inputs from the channels to this node
        var input_len = 76 // id sig amount

        for(var i=0;i<args[0];i++){
          // get withdrawal tx
          var start = 1+i*len
          ({id, sig, methodId, args} = me.parseTx(args.slice( start, start+len )))
          // (nonce methodId receiver are omitted)

        }


        l(`new i ${i}`)
    }






  }


  // reward/mint for helping the network
  reward(amount, id){

  }




  async post(method, args){
    var methodId = onchainMethods.indexOf(method)
    assert(methodId != -1, "No such method")

    switch(method){
      case 'settle':


    }

/*

*/


    var nonce = Buffer.alloc(4)
    nonce.writeUInt32BE(this.byKey().nonce)

    // first is omitted parts, second is required
    var tx = this.sign(nonce, concat(write32(methodId), args))

    // 1. figure out who is current coordinator
    var spirits_number = 3
    var period = 20
    var crd_index = Math.floor(ts() / period) % spirits_number

    var ordered_crd = [1, 3, 2]
    //ordered_crd[crd_index]
    if(me.nearest.readyState != me.nearest.OPEN){
      await me.findNearest(a=>me.nearest.send('feed me blocks!'))
    }

    this.nearest.send(tx)
    l(`Broadcasting ${tx} to nearest`)


    return tx;
  }

  async pay(){

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

  initCoordinator(){
    var wss = new WebSocket.Server({ port: 8081 });
    wss.on('connection', function(ws) {
      ws.on('message', me.processTx);
    });
  }



  initHub(){
    initService(8082, function(ws, tx){

    })
  }


  findNearest(onopen){
    // connecting to geo-selected nearest coordinator (lowest latency)
    this.nearest = new WebSocket('ws://127.0.0.1:8081');

    this.nearest.on('error', l) // repeat

    this.nearest.on('open', onopen);
    this.nearest.on('message', function(block) {

      var len = 68 // id+sig
      for(var i = 0;i<block[0];i++){
        var slice_from = i*len + 1
        l(block.slice(slice_from, slice_from + len))
      }

    });
  }

  // [1,2,3][1,2,3] - useful for blocks and settle parsing
  unpackArrays(buf, firstSize, secondSize){

  }



  getCurrentCoodinator(){

  }










}



getRootOfTrust=a=>{
  shasum = crypto.createHash('sha256')
  s = fs.ReadStream('./db.sqlite')
  s.on('data', function(data) {
    shasum.update(data)
  })
  s.on('end', function() {
    console.log(shasum.digest('hex'))
  })
}


originAllowence = {
  'null': 400
}


var protocol = require('./protocol');
var DNSserver = require('dgram').createSocket('udp4');
DNSserver.on('message', function(buffer, rinfo) {
  var d = protocol.decode(buffer, 'queryMessage')
  var name = d.val.question.name
  var qtype = d.val.question.type


  if(name.endsWith('.we') && (qtype == 1 || qtype == 28)){
    d.val.header.flags.qr=1
    d.val.header.anCount=1
//target: '::1', _type: 'AAAA'
    console.log('WeDNS: '+name+' from ' + rinfo.address +':' + rinfo.port);
    var encoded = protocol.encode({
            header: d.val.header,
            question: d.val.question,
            answers: [{
                  name:   name,
                  rtype:  1,
                  rclass: 1,
                  rttl:   300,
                  rdata:  { target: '127.0.0.1', _type: 'A' }
          }]
    }, 'answerMessage');

    DNSserver.send(encoded, 0, encoded.length, rinfo.port, rinfo.address, function (err, bytes) {
      if(err) console.log(err);
    })
  }else{
    console.log("unknown type ",d)
  }
});

console.log('Set up DNS so .we are served from /apps folder')
DNSserver.bind(53,'127.0.0.1');




  initDashboard=a=>{

  var finalhandler = require('finalhandler');
  var serveStatic = require('serve-static');

  // this serves dashboard HTML page
  var server = http.createServer(function(req, res) {
    res.statusCode = 200;
    console.log(req.headers)
    var app_name = req.headers.host.match(/([a-z]+)\.we(:[0-9]+)?/)
    if(app_name){
      console.log("serving ./apps/"+app_name[1]);

      serveStatic("./apps/"+app_name[1])(req, res, finalhandler(req, res));
    }else{
      res.end('No such app '+req.headers.host)
    }
    //res.setHeader('Access-Control-Allow-Origin', '*');
    //res.setHeader('Content-Type', 'text/html');
  });

  console.log('Set up HTTP server at 80')
  server.listen(80);

  var wss = new WebSocket.Server({ port: 8085 });
  console.log('Set up websocket server to accepts commands')
  wss.on('connection', function(ws,req) {
    // Origin = our proxy, and initiated by this device
    if(req.headers.origin == 'http://127.0.0.1:8084' && isLocalhost(req.connection.remoteAddress)){

      ws.on('message', msg=>{
        json = JSON.parse(msg)

        if(json.method == 'pay'){
          // some Origins are whitelisted for Smooth Payments
          if(json.confirmed || originAllowence[json.proxyOrigin] >= json.params.amount){
            me.post()
            originAllowence[json.proxyOrigin] -= json.params.amount

            ws.send(JSON.stringify({
              status: 'paid'
            }))

          }else{
            // request explicit confirmation
            json.confirmation = true
            ws.send(JSON.stringify(json))
          }

        }
      });
    }

  });

}



isLocalhost=(ip)=>{
  return ['127.0.0.1', '::ffff:127.0.0.1', '::1'].indexOf(ip) != -1 || ip.indexOf('::ffff:127.0.0.1:') == 0
}


async function derive(username, pw){
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




// define db

Sequelize = require('sequelize');
Op = Sequelize.Op;

sequelize = new Sequelize('database', 'username', 'password', {
  timestamps: false,

  dialect: 'sqlite',
  storage: 'db.sqlite'
});

opts = {
  timestamps: false
}

// two kinds of storage: 1) critical database that might be used by code
// 2) complementary stats like updatedAt that's useful in exploring and can be deleted safely

User = sequelize.define('user', {
  username: Sequelize.STRING,
  pubkey: Sequelize.CHAR(32).BINARY,
  nonce: Sequelize.INTEGER,
  balance: Sequelize.BIGINT, // mostly to pay taxes
  service_policy: Sequelize.TEXT
}, opts);

Proposal = sequelize.define('proposal', {
  title: Sequelize.STRING,
  description: Sequelize.TEXT
}, opts)

Edge = sequelize.define('edge', {
  user_id: {
    type: Sequelize.INTEGER,
    references: {
      model: User,
      key: 'id'
    }
  },
  hub_id: {
    type: Sequelize.INTEGER,
    references: {
      model: User,
      key: 'id'
    }
  },

  extra: Sequelize.TEXT,
  kindof: Sequelize.INTEGER
}, opts)


//me.record.addHub(x, { through: { type: 'channel' }});


User.belongsToMany(User, {through: 'Edge', as: 'hub'});
User.belongsToMany(User, {through: 'Edge', as: 'user'});

//really basic key value system for internal vars
KV = sequelize.define('kv', {
  k: Sequelize.STRING,
  v: Sequelize.STRING
}, opts)

function set(k, v){
  KV.create({k: "x", v: "y"})
}



// setup init data
genesis = a=>{
  sequelize.sync({force: true}).then(a =>{
    var u = []
    for(var i = 0; i< 100;i++){
      u[i] = new Me("u"+i,'password')
    }


    st = new Date(0)
    setTimeout(a=>{

      for(var i = 0; i< 100;i++){
        User.create({
          pubkey: Buffer.from(u[i].id.publicKey),
          username: "u"+i,
          nonce: 0,
          balance: wed(1000)
        })
      }


    }, 7000)
  })
}




async function main(){
  chosen = process.argv[2] ? parseInt(process.argv[2]) : 1
  me = new Me('u'+chosen, 'password')
  initDashboard()
}

main()




const repl = require('repl');
const babel = require('babel-core');

function preprocess(input) {
  const awaitMatcher = /^(?:\s*(?:(?:let|var|const)\s)?\s*([^=]+)=\s*|^\s*)(await\s[\s\S]*)/;
  const asyncWrapper = (code, binder) => {
    let assign = binder ? `global.${binder} = ` : '';
    return `(function(){ async function _wrap() { return ${assign}${code} } return _wrap();})()`;
  };

  // match & transform
  const match = input.match(awaitMatcher);
  if (match) {
    input = `${asyncWrapper(match[2], match[1])}`;
  }
  return input;
}

function myEval(cmd, context, filename, callback) {
  _eval(preprocess(cmd), context, filename, callback);
}


const replInstance = repl.start({ prompt: '> ' });
const _eval = replInstance.eval;

Object.assign(replInstance.context, {
  Me: Me
})

replInstance.eval = myEval.bind(this);


// debug REPL .load u.js
//require('repl').start({useGlobal: true})
