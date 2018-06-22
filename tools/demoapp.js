// Full featured demo of an integration with deposits/withdrawals.
// TODO: e2e headless test of its functions

// npm i axios cookies
axios = require('axios')
l = console.log
crypto = require('crypto')
rand = () => crypto.randomBytes(32).toString('hex')

rr = false

fs = require('fs')
users = {}

nacl = require('../lib/nacl')

// define merchant node path

if (fs.existsSync('/root/fs/data8002/offchain/pk.json')) {
  FS_PATH = '/root/fs/data8002/offchain'
  FS_RPC = 'http://127.0.0.1:8002/rpc'
} else {
  FS_PATH = '/Users/homakov/work/fs/data8002/offchain'
  FS_RPC = 'http://127.0.0.1:8002/rpc'
}

// pointing browser SDK to user node
LOCAL_FS_RPC = 'http://127.0.0.1:8001'

var processUpdates = async () => {
  r = await FS('receivedAndFailed')

  if (!r.data.receivedAndFailed) return l("no data found")
    
  for (var obj of r.data.receivedAndFailed) {
    let uid = Buffer.from(obj.invoice, 'hex').toString()

    // checking if uid is valid
    if (users.hasOwnProperty(uid)) {
      if (obj.is_inward) {
        l("New deposit to "+uid)
      } else {
        l("Refund because failed to withdraw for "+uid)
      }
      users[uid] += obj.amount
    }
  }

  setTimeout(processUpdates, 1000)
}

post = async (url, params) => {
  return new Promise((resolve) => {})
}

FS = (method, params = {}) => {
  return axios.post(FS_RPC, {
    method: method,
    auth_code: auth_code,
    params: params
  })
}


commy = (b, dot = true) => {
  let prefix = b < 0 ? '-' : ''

  b = Math.abs(b).toString()
  if (dot) {
    if (b.length == 1) {
      b = '0.0' + b
    } else if (b.length == 2) {
      b = '0.' + b
    } else {
      var insert_dot_at = b.length - 2
      b = b.slice(0, insert_dot_at) + '.' + b.slice(insert_dot_at)
    }
  }
  return prefix + b.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}


httpcb = async (req, res) => {
  var id = false

  if (req.headers.cookie) {
    var id = req.headers.cookie.split('id=')[1]
    l('Loaded id ' + id)
  }

  res.status = 200

  if (req.url == '/') {
    if (!id) {
      id = rand()
      l('Set cookie')
      res.setHeader('Set-Cookie', 'id=' + id)
      repl.context.res = res
    }
    if (!users[id]) users[id] = 0 // Math.round(Math.random() * 1000000)

    res.end(`

<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="/bootstrap.min.css">
  <script src="/axios.js"></script>
</head>

<body>
  <main role="main" class="container" id="main">
    <h1 class="mt-5">Bank / Exchange Integration Demo</h1>

    <p>Your account in our bank: ${id}</p>
    <p>Available Balance: <b>\$${commy(users[id])}</b></p>
   
    <h3>Deposit</h3>
    <a href="#" id="deposit">${address}</a>

    <h3>Withdraw</h3>
    <p><input type="text" id="destination" placeholder="Destination"></p>
    <p><input type="text" id="out_amount" placeholder="Amount"></p>
    <p><button class="btn btn-success" id="withdraw">Withdraw</button></p>
   

 </main>


<script>
l=console.log
id = '${id}'

fs_origin = '${LOCAL_FS_RPC}'

var fallback = setTimeout(()=>{
//main.innerHTML="Couldn't connect to local node at ${LOCAL_FS_RPC}. <a href='https://fairlayer.com/#install'>Please install Fairlayer first</a>"
}, 3000)


</script>
<script>


window.onload = function(){

withdraw.onclick = function(){
  axios.post('/init', {
    destination: destination.value,
    out_amount: out_amount.value
  }).then((r2)=>{
    if (r2.data.status == 'paid') {
      location.reload()
      
    } else {
      alert(r2.data.error)
    }
  })
}

/*
  var invoice = Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(32)), function(byte) {
    return ('0' + (byte & 0xFF).toString(16)).slice(-2);
 }).join('')
 */


deposit.onclick = function(){
  fs_w = window.open(fs_origin+'#wallet?invoice='+id+"&address=${address}&amount=10")

  window.addEventListener('message', function(e){
    if(e.origin != fs_origin) return

    fs_w.close()
    setTimeout(()=>{
      location.reload()
    }, 1000)
  })


}



}
</script>
</body></html>

    `)
  } else if (req.url == '/init') {
    var queryData = ''
    req.on('data', function(data) {
      queryData += data
    })

    req.on('end', async function() {
      var p = JSON.parse(queryData)

      l('init ', p)

      if (p.destination) {
        var amount = Math.round(parseFloat(p.out_amount) * 100)

        if (users[id] < amount) {
          l('Not enough balance')
          return false
        }
        users[id] -= amount
        r = await FS('send', {
          outward: {
            destination: p.destination,
            amount: amount,
            invoice: id,
            asset: 1
          }
        })
        l(r.data)
        res.end(JSON.stringify({status: 'paid'}))
      }
    })
  } else {
    require('serve-static')(require('path').resolve(__dirname, '.'))(req, res, require('finalhandler')(req, res))
  }
}





address = '';

init = async () => {

  if (fs.existsSync(FS_PATH + '/pk.json')) {
    auth_code = JSON.parse(fs.readFileSync(FS_PATH + '/pk.json')).auth_code
    l('Auth code to our node: ' + auth_code)
  } else {
    l("No auth")
    return setTimeout(init, 1000)
  }

  r = await FS('getinfo')
  if (!r.data.address) {
    l('No address')
    return setTimeout(init, 1000)
  }



  require('http')
    .createServer(httpcb)
    .listen(3010)

  address = r.data.address
  l('Our address: ' + address)
  processUpdates()


  try{
    require('../lib/opn')('http://127.0.0.1:3010')
  } catch(e){} 
}

init()

repl = require('repl').start()
