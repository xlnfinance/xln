assert = require("assert");
crypto = require("crypto");
fs = require("fs")
http = require("http");


// deterministic JSON
const stringify = require('./lib/stringify')
const keccak = require('keccak')
const BN = require('bn.js')
nacl = require('tweetnacl')
WebSocket = require("ws")
rlp = require('rlp')

const opn = require('../opn')

//diff2html = require("diff2html").Diff2Html
//diff2html.getPrettyHtmlFromDiff(f)

child_process = require('child_process')
const {spawn, exec, execSync} = child_process;

Sequelize = require('sequelize')
Op = Sequelize.Op;
asyncexec = require('util').promisify(exec)


const [Me] = require('./lib/me')




l = console.log
d = ()=>{}

r = function(a){
  if(a instanceof Buffer){
    return rlp.decode(a)
  }else{
    return rlp.encode(a)
  }
}

readInt = (i)=>i.readUIntBE(0, i.length)

toHex = (inp) => Buffer.from(inp).toString('hex')
bin=(data)=>Buffer.from(data)
sha3 = (a)=>keccak('keccak256').update(bin(a)).digest()

// TODO: not proper alg
kmac = (key, msg)=>keccak('keccak256').update(key).update(bin(msg)).digest()

ts = () => Math.round(new Date/1000)

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



// used to authenticate browser sessions to this daemon
const auth_code = toHex(crypto.randomBytes(32))
process.title = 'Failsafe'

usage = ()=>{
  Object.assign(process.cpuUsage(), process.memoryUsage(), {uptime: process.uptime()})
}


//http://ipinfo.io/ip 
genesis = async (opts)=>{
  //await(fs.rmdir('data'))

  l("Start genesis")


  await (sequelize.sync({force: true}))

  opts = Object.assign({
    username: 'root', 
    pw: 'password', 
    location: location.host // for local tests
    //infra: 'https://www.digitalocean.com'
  }, opts)



  l(opts)

  // entity / country / infra 


  var seed = await derive(opts.username, opts.pw)
  delete(opts.pw)

  me = new Me
  await me.init(opts.username, seed);

  var user = await (User.create({
    pubkey: bin(me.id.publicKey),
    username: opts.username,
    nonce: 0,
    balance: 100000000,
    fsb_balance: 10000
  }))


  K = {
    //global network pepper to protect derivation from rainbow tables
    network_name: opts.username, 

    usable_blocks: 0,
    total_blocks: 0,
    total_tx: 0,
    total_bytes: 0,

    total_tx_bytes: 0,

    voting_period: 10,

    bytes_since_last_snapshot: 999999999, // force to do a snapshot on first block
    last_snapshot_height: 0,
    snapshot_after_bytes: 10000, //100 * 1024 * 1024,
    proposals_created: 0,

    
    tax_per_byte: 2,


    account_creation_fee: 100,


    blocksize: 6*1024*1024,
    blocktime: 10,
    majority: 1,
    prev_hash: toHex(Buffer.alloc(32)),

    ts: 0,

    created_at: ts(),

    assets: [
      { 
        ticker: 'FSD',
        name: "Failsafe Dollar",
        total_supply: user.balance
      },
      {
        ticker: 'FSB',
        name: "Bond 2030",
        total_supply: user.fsb_balance
      }
    ],

    members: [],
    hubs: []
  }

  K.members.push({
    id: user.id,

    username: opts.username,
    location: opts.location,

    block_pubkey: me.block_pubkey,

    missed_blocks: [],
    shares: 300,

    hubId: 1,
    hub: "proto"
  })



  var json = stringify(K)
  fs.writeFileSync('data/k.json', json)

  me.K = K
  me.members = JSON.parse(json).members // another object ref

  l('Done')
}












// used just for convenience in parsing
inputMap = (i)=>{
  // up to 256 input types for websockets
  var map = [
  'tx', 'auth', 'needSig', 'signed', 
  'block', 'chain', 'sync', 
  'mediate', 'receive'
  ]
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
    'delta',    // delayed balance proof


    'propose',

    'voteApprove',
    'voteDeny',

    'auth', // any kind of off-chain auth signatures between peers

    'fsd',
    'fsb',


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

  'propose',

  'voteApprove',
  'voteDeny',
]

K = false

loadJSON = ()=>{
  if(fs.existsSync('data/k.json')){
    var json = fs.readFileSync('data/k.json')
    K = JSON.parse(json)

    me.K = K
    me.members = JSON.parse(json).members // another object ref
      
    
  }
}







postPubkey = (pubkey, msg)=>{

}

trustlessInstall = async a=>{
  tar = require('tar')
  var filename = 'Failsafe-'+K.total_blocks+'.tar.gz'
  l("generating install "+filename)
  tar.c({
      gzip: true,
  		portable: true,
      file: 'private/'+filename,
      filter: (path,stat)=>{
        stat.mtime = null // must be deterministic
        // disable /private (blocks sqlite, proofs, local config) allow /default_private
        if(path.match(/(\.DS_Store|private)/)){
          l('skipping '+path)
          return false;
        }
        return true;
      }
    },
    ['.']
  ).then(_=>{
    l("Snapshot "+filename)
  })

}

installSnippets = {}
installSnippet = async (i)=>{
  if(installSnippets[i]){
    return installSnippets[i]
  }else{
    var filename=`Failsafe-${i}.tar.gz`
    exec("shasum -a 256 private/"+filename, async (er,out,err)=>{
      if(out.length == 0){
        l('This state doesnt exist')
        return false
      }

      var out_hash = out.split(' ')[0]
      var host = me.my_member.location.split(':')[0]
      var out_location = 'http://'+host+':'+base_port+'/'+filename
      installSnippets[i] = `id=${base_port+1};f=${filename};mkdir $id && cd $id && curl http://${host}:${base_port}/$f -o $f;if shasum -a 256 $f | grep ${out_hash}; then tar -xzf $f && rm $f; node u.js start $id; fi`
    return installSnippets[i];
    })
  }
}

originAllowence = {
  'null': 400,
  'http://127.0.0.1:8000': 500
}




initDashboard=async a=>{
  var finalhandler = require('finalhandler');
  var serveStatic = require('serve-static');

  // this serves dashboard HTML page
  var server = http.createServer(function(req, res) {
    

    if(req.url.match(/^\/Failsafe-([0-9]+)\.tar\.gz$/)){
      var file = 'private'+req.url
      var stat = fs.statSync(file);
      res.writeHeader(200, {"Content-Length": stat.size});
      var fReadStream = fs.createReadStream(file);
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
   }else{


    serveStatic("../wallet")(req, res, finalhandler(req, res));
   }


  });

  l('Set up HTTP server at '+base_port)

  server.listen(base_port).on('error', l)

  var url = 'http://0.0.0.0:'+base_port+'/#code='+auth_code
  l("Open "+url+" in your browser to get started")
  //opn(url)


  me = new Me
  loadJSON()

  //setInterval(sync, 60000)

  wss = new WebSocket.Server({ server: server, maxPayload:  64*1024*1024 });
  
  wss.users = {}

  wss.on('connection', function(ws,req) {
    ws.on('message', async msg=>{
      if(msg[0] == '{'){
        var result = {}

        var json = JSON.parse(msg)
        var p = json.params

        // prevents all kinds of CSRF and DNS rebinding
        // strong coupling between the console and the browser client
          

        if(json.code == auth_code){
          switch(json.method){
            case 'sync':
              result.confirm = "Syncing the chain..."
              sync()

              break
            case 'load':
              if(p.username){
                if(p.location && !K){
                  await genesis({username, pw, location} = p)

                }

                var seed = await derive(p.username, p.pw)
                me.init(p.username, seed)

                result.confirm = "Welcome!"
                
                await me.connect()

              }

              break
            case 'logout':         
              me.id = false
              result.pubkey = false

              break

            case 'send':

              var hubId = 1

              var amount = parseInt(parseFloat(p.off_amount)*100)

              if(p.off_to.length == 64){
                var mediate_to = Buffer.from(p.off_to, 'hex')
              }else{
                var mediate_to = await User.findById(parseInt(p.off_to))
                if(mediate_to){
                  mediate_to = mediate_to.pubkey
                }else{
                  result.alert = "This user ID is not found"
                  break
                }
              }



              me.payChannel(hubId, amount, mediate_to)
              result.confirm = `Sent ${amount} to ${mediate_to.toString('hex')}`


            break

            case 'settleUser':

              //settle fsd ins outs

              // contacting hubs and collecting instant withdrawals ins

              var outs = []
              for(o of p.outs){
                // split by @
                if(o.to.length > 0){
                  var to = o.to.split('@')

                  var hubId = to[1] ? parseInt(to[1]) : 0

                  if(to[0].length == 64){
                    var userId = Buffer.from(to[0], 'hex')

                    // maybe this pubkey is already registred?
                    var u = await User.findOne({where: {
                      pubkey: userId
                    }})

                    if(u){
                      userId = u.id
                    }

                  }else{
                    var userId = parseInt(to[0])

                    var u = await User.findById(userId)

                    if(!u){
                      result.alert = "User with short ID "+userId+" doesn't exist."
                    }
                  }

                  if(o.amount.indexOf('.')==-1) o.amount+='.00'

                  var amount = parseInt(o.amount.replace(/[^0-9]/g, ''))

                  if(amount > 0){
                    outs.push([userId, hubId, amount])
                  }
                }

              }

              if(!result.alert){
                var encoded = r([Buffer([p.assetType == 'FSD' ? 0 : 1]), p.ins, outs])
                
                me.broadcast('settleUser', encoded)
                
                result.confirm = 'Global transaction is broadcasted. Please wait for it to be confirmed'


              }

              break
            case 'pay':
              if(json.confirmed || originAllowence[json.proxyOrigin] >= json.params.amount){
                //me.pay('')

                originAllowence[json.proxyOrigin] -= json.params.amount
                result = 'paid'
              }else{
                // request explicit confirmation
                json.confirmation = true
                ws.send(JSON.stringify(json))
              }
              break

            case 'login':
              // sign external domain
              result = toHex(nacl.sign(json.proxyOrigin, me.id.secretKey))

            break

            case 'propose':
              me.broadcast('propose', p)
              result.confirm = "Proposal submitted!"

            break

            case 'vote':
              me.broadcast(p.approve ? 'voteApprove' : 'voteDeny', r([p.id, p.rationale]) ) 
              result.confirm = "You voted! Good job!"

            break
          }

          if(me.id){
            result.record = await me.byKey()

            result.username = me.username // just for welcome message

            result.pubkey = toHex(me.id.publicKey)

            result.ch = await me.channel(1)

          }
        }

        if(K){

          result.K = K

          if(me.my_member && K.last_snapshot_height){
            result.install_snippet = await installSnippet(K.last_snapshot_height)
          }

          result.proposals = await Proposal.findAll({
            order: [['id','DESC']], 
            include: {all: true}
          })
        }

        ws.send(JSON.stringify({
          result: result,
          id: json.id
        }))


      }else{
        me.processInput(ws,msg)
      }

    })


  });


}


derive = async (username, pw)=>{
  var seed = await require('scrypt').hash(pw, {
    N: Math.pow(2, 18),
    interruptStep: 1000,
    p: 3,
    r: 8,
    dkLen: 32,
    encoding: 'base64'
  }, 32, username)

  l(`Derived ${seed.toString('hex')} for ${username}:${pw}`)

  return seed;
}

// this is onchain database - shared among everybody
var base_db = {
  dialect: 'sqlite',
  storage: 'data/db.sqlite',
  define: {timestamps: false},
  operatorsAliases: false,
  logging: false
}

sequelize = new Sequelize('', '', 'password', base_db);

// two kinds of storage: 1) critical database that might be used by code
// 2) complementary stats like updatedAt that's useful in exploring and can be deleted safely

User = sequelize.define('user', {
  username: Sequelize.STRING,

  pubkey: Sequelize.CHAR(32).BINARY,

  nonce: Sequelize.INTEGER,
  balance: Sequelize.BIGINT, // mostly to pay taxes
  fsb_balance: Sequelize.BIGINT // standalone bond 2030

});

Proposal = sequelize.define('proposal', {
  desc: Sequelize.TEXT,
  code: Sequelize.TEXT,
  patch: Sequelize.TEXT,

  delayed: Sequelize.INTEGER,

  kindof: Sequelize.STRING
})

Collateral = sequelize.define('collateral', {
  nonce: Sequelize.INTEGER, // for instant withdrawals


  collateral: Sequelize.BIGINT, // collateral
  settled: Sequelize.BIGINT, // what hub already collateralized

  assetType: Sequelize.CHAR(1).BINARY,

  delayed: Sequelize.INTEGER
  // dispute has last nonce, last agreed_balance
})




Vote = sequelize.define('vote', {
  rationale: Sequelize.TEXT,
  approval: Sequelize.BOOLEAN // approval or denial
})

//promises


Proposal.belongsTo(User);

User.belongsToMany(User, {through: Collateral, as: 'hub'});

Proposal.belongsToMany(User, {through: Vote, as: 'voters'});


// this is off-chain private database for blocks and other balance proofs
// for things that new people don't need to know and can be cleaned up

if(!fs.existsSync('private')) fs.mkdirSync('private')

base_db.storage = 'private/db.sqlite'
privSequelize = new Sequelize('', '', 'password', base_db);

Block = privSequelize.define('block', {
  block: Sequelize.CHAR.BINARY,
  hash: Sequelize.CHAR(32).BINARY,
  prev_hash: Sequelize.CHAR(32).BINARY
})

// stored signed deltas
Delta = privSequelize.define('delta', {
  userId: Sequelize.CHAR(32).BINARY,
  hubId: Sequelize.INTEGER,

  sig: Sequelize.CHAR(64).BINARY,

  nonce: Sequelize.INTEGER,

  delta: Sequelize.INTEGER
})



Event = privSequelize.define('event', {
  data: Sequelize.CHAR.BINARY,
  kindof: Sequelize.STRING,
  p1: Sequelize.STRING
})

privSequelize.sync({force: false})




sync = ()=>{
  if(K.prev_hash){
    me.sendMember('sync', Buffer.from(K.prev_hash, 'hex'), 0)
  }
}







if(process.argv[2] == 'start'){
  base_port = process.argv[3] ? process.argv[3] : 8000

  /*
  var cluster = require('cluster')
  if (cluster.isMaster) {
    cluster.fork();

    cluster.on('exit', function(worker, code, signal) {
      console.log('exit')
      //cluster.fork();
    });
  }

  if (cluster.isWorker) {*/
    initDashboard()
  //}
}




require('repl').start('> ')



