#!/usr/bin/env node

//system
assert = require("assert");
fs = require("fs")
http = require("http");
os = require('os')
ws = require("uws")
opn = require('./lib/opn')

//crypto
crypto = require("crypto");
//scrypt = require('scrypt') // require('./scrypt_'+os.platform())

keccak = require('keccak')
nacl = require('./lib/nacl')
ec = nacl.sign.detached

//encoders
BN = require('bn.js')
stringify = require('./lib/stringify')
rlp = require('rlp')




base_port = process.argv[2] ? parseInt(process.argv[2]) : 8000



child_process = require('child_process')
const {spawn, exec, execSync} = child_process;

Sequelize = require('sequelize')
Op = Sequelize.Op;
asyncexec = require('util').promisify(exec)


Me = require('./lib/me').Me




l = console.log
d = l //()=>{}

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




concat = function() {
  return Buffer.concat(Object.values(arguments));
}




// used to authenticate browser sessions to this daemon
const auth_code = toHex(crypto.randomBytes(32))
process.title = 'Failsafe'

usage = ()=>{
  Object.assign(process.cpuUsage(), process.memoryUsage(), {uptime: process.uptime()})
}







// used just for convenience in parsing
inputMap = (i)=>{
  // up to 256 input types for websockets
  var map = [
  'tx', 'auth', 'needSig', 'signed', 
  'block', 'chain', 'sync', 
  'mediate', 'receive', 'faucet'
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
    'placeholder',

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
    return map.indexOf(i)
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
    
    me.members.map(f=>{
      f.block_pubkey = Buffer.from(f.block_pubkey,'hex')
    })

    
  }
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
        if(path.match(/(\.DS_Store|private|node_modules|test)/)){
          //l('skipping '+path)
          return false;
        }
        return true;
      }
    },
    ['.']
  ).then(_=>{

    l("Snapshot made: "+filename)
    
  })

}


cached_result = {}

cache = async (i)=>{
  if(K){ // already initialized
    cached_result.is_hub = me.is_hub

    cached_result.K = K

    if(me.is_hub){
      var h = require('./private/hub')
      h = await h()
      cached_result.deltas = h.channels
      cached_result.solvency = h.solvency
    }

    cached_result.proposals = await Proposal.findAll({
      order: [['id','DESC']], 
      include: {all: true}
    })

    cached_result.users = await User.findAll({include: {all: true}})
  }


  if(me.my_member && K.last_snapshot_height){
    var filename=`Failsafe-${K.last_snapshot_height}.tar.gz`
    var cmd = "shasum -a 256 private/"+filename

    exec(cmd, async (er,out,err)=>{
      if(out.length == 0){
        l('This state doesnt exist')
        return false
      }

      var out_hash = out.split(' ')[0]
      var host = me.my_member.location.split(':')[0]
      var out_location = 'http://'+host+':'+base_port+'/'+filename
      cached_result.install_snippet = `id=${base_port+1}
f=${filename}
mkdir $id && cd $id && curl http://${host}:${base_port}/$f -o $f
if [ ! -x /usr/bin/sha256sum ]; then alias sha256sum="shasum -a 256";fi
if sha256sum $f | grep ${out_hash}; then
  tar -xzf $f && rm $f && ./install && node fs.js ${base_port+1}
fi`

    })

  }

}

originAllowence = {
  'null': 400,
  'http://127.0.0.1:8000': 500
}


me = false

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


    serveStatic("./wallet")(req, res, finalhandler(req, res));
   }


  });

  l('Set up HTTP server at '+base_port)

  server.listen(base_port).on('error', l)

  var url = 'http://0.0.0.0:'+base_port+'/#auth_code='+auth_code
  l("Open "+url+" in your browser to get started")
  opn(url)


  me = new Me
  loadJSON()

  
  wss = new ws.Server({ server: server, maxPayload:  64*1024*1024 });
  
  wss.users = {}

  wss.on('error',function(err){ console.error(err)})

  wss.on('connection', function(ws) {
    ws.on('message', async msg=>{
       // uws requires explicit conversion
      if(msg[0] != '{'){ //{
        me.processInput(ws, msg)
      
      }else{
        msg = bin(msg).toString()

        var result = {}

        var json = JSON.parse(msg)
        var p = json.params

        // prevents all kinds of CSRF and DNS rebinding
        // strong coupling between the console and the browser client
          

        if(json.auth_code == auth_code){
          //me.browser = ws

          switch(json.method){
            case 'sync':
              result.confirm = "Syncing the chain..."
              sync()

              break
            case 'load':
              if(p.username){
                var seed = await derive(p.username, p.pw)
                me.init(p.username, seed)

                await me.start()
                await cache()

                result.confirm = "Welcome!"                
              }

              break
            case 'logout':         
              me.id = false
              result.pubkey = false

              break

            case 'takeEverything':

              var ch = await me.channel(1)
              // post last available signed delta
              await me.broadcast('settleUser', r([ 0, [ch.delta_record.sig ? ch.delta_record.sig : 1], [] ]) )
              result.confirm = "Started a dispute onchain. Please wait a delay period to get your money back."
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

              var [status, error] = await me.payChannel(hubId, amount, mediate_to)
              if(error){
                result.alert = error
              }else{
                result.confirm = `Sent \$${p.off_amount} to ${p.off_to}!`
              }


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
                var encoded = r([0, p.ins, outs])
                
                result.confirm = await me.broadcast('settleUser', encoded)
              }

              break
            case 'faucet':
              me.sendMember('faucet', bin(me.id.publicKey), 0)
              result.confirm = "Faucet triggered. Check your wallet!"

              break
            case 'pay':
              if(json.confirmed || originAllowence[json.proxyOrigin] >= json.params.amount){
                //me.pay('')

                originAllowence[json.proxyOrigin] -= json.params.amount
                await me.payChannel(1, parseInt(json.params.amount), Buffer.from(json.params.recipient, 'hex'))
                result = 'paid'
              }else{
                // request explicit confirmation
                json.confirmation = true
                ws.send(JSON.stringify(json))
              }
              break

            case 'login':
              // sign external domain
              result.token = toHex(nacl.sign(json.proxyOrigin, me.id.secretKey))

            break

            case 'propose':
              result.confirm = await me.broadcast('propose', p)
              

            break


            case 'vote':
              result.confirm = await me.broadcast(p.approve ? 'voteApprove' : 'voteDeny', r([p.id, p.rationale]) ) 

            break
          }

          if(me.id){
            result.record = await me.byKey()

            result.username = me.username // just for welcome message

            result.pubkey = toHex(me.id.publicKey)
            

            if(!me.is_hub) result.ch = await me.channel(1)

          }
        }

        Object.assign(result, cached_result)

        ws.send(JSON.stringify({
          result: result,
          id: json.id
        }))


      }

    })


  });





}


derive = async (username, pw)=>{

  return new Promise((resolve,reject)=>{
    require('./lib/scrypt')(pw, username, {
        N: Math.pow(2, 16),
        r: 8,
        p: 2,
        dkLen: 32,
        encoding: 'binary'
    }, (r)=>{
      r = bin(r)
      l(`Derived ${r.toString('hex')} for ${username}:${pw}`)
      resolve(r)
    });

/*
    var seed = await scrypt.hash(pw, {
      N: Math.pow(2, 16),
      interruptStep: 1000,
      p: 2,
      r: 8,
      dkLen: 32,
      encoding: 'binary'
    }, 32, username)


    return seed;*/

  })

}

// this is onchain database - shared among everybody
var base_db = {
  dialect: 'sqlite',
  //dialectModulePath: 'sqlite3',
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

  assetType: Sequelize.INTEGER,

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

  sig: Sequelize.TEXT,

  nonce: Sequelize.INTEGER,

  instant_until: Sequelize.INTEGER,

  delta: Sequelize.INTEGER
})



Event = privSequelize.define('event', {
  data: Sequelize.CHAR.BINARY,
  kindof: Sequelize.STRING,
  p1: Sequelize.STRING
})




sync = ()=>{
  if(K.prev_hash){
    me.sendMember('sync', Buffer.from(K.prev_hash, 'hex'), 0)
  }
}




city = async ()=>{

  var u = []
  for(var i = 0;i<1000;i++){
    u[i] = new Me
    var b = Buffer.alloc(32)
    b.writeInt32BE(i)
    u[i].init('u'+i, b)
  }

  l('Ready')


}


if(process.argv[2] == 'console'){

}else if(process.argv[2] == 'city'){
  city()

}else if(process.argv[2] == 'genesis'){
  require('./private/genesis')({location: process.argv[3]})
}else{

  privSequelize.sync({force: false})

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


process.on('unhandledRejection', r => console.log(r))

require('repl').start('> ')



