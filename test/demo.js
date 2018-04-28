// Full featured demo of an integration with deposits/withdrawals.
// TODO: e2e headless test of its functions

// npm i axios cookies
axios = require('axios')
l = console.log
crypto = require('crypto')
rand = () => crypto.randomBytes(32).toString('hex')

Cookies = require('cookies')
fs = require('fs')
users = {}

nacl = require('../lib/nacl')

// define merchant node path
FS_PATH = fs.existsSync('/root/8002/private/pk.json')
  ? '/root/8002'
  : '/Users/homakov/work/8002'

FS_RPC = 'http://127.0.0.1:8002/rpc'

l(FS_PATH)

// pointing browser SDK to user node
LOCAL_FS_RPC = 'http://127.0.0.1:8001'

if (fs.existsSync(FS_PATH + '/private/pk.json')) {
  auth_code = JSON.parse(fs.readFileSync(FS_PATH + '/private/pk.json'))
    .auth_code
  l('Auth code to our node: ' + auth_code)
} else {
  throw 'No auth'
}

var processInvoices = async () => {
  invoices = await FS('invoices')
  l(invoices)
  for (var i of invoices) {
    users[i.invoice] += i.amount
  }

  setTimeout(processInvoices, 1000)
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

require('http')
  .createServer(async (req, res) => {
    cookies = new Cookies(req, res)

    r = await FS('getinfo')
    address = r.data.address

    res.status = 200

    var id = cookies.get('id')

    if (req.url == '/') {
      if (!id) {
        id = rand()
        cookies.set('id', id)
      }
      if (!users[id]) users[id] = Math.round(Math.random() * 1000000)

      require('serve-static')('../wallet')(
        req,
        res,
        require('finalhandler')(req, res)
      )

      res.end(`


<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/4.0.0/css/bootstrap.min.css" integrity="sha384-Gn5384xqQ1aoWXA+058RXPxPg6fy4IWvTNh0E263XmFcJlSAwiGgFAW/dAiS6JXm" crossorigin="anonymous">
    <script src="https://unpkg.com/axios/dist/axios.min.js"></script>
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
  //main.innerHTML="Couldn't connect to local node at ${LOCAL_FS_RPC}. <a href='https://failsafe.network/#install'>Please install Failsafe first</a>"
}, 3000)


window.addEventListener('message', function(e){
  if(e.origin == fs_origin){
    l(e.data)
    location.reload()
  }
})



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

  deposit.onclick = function(){
    var invoice = Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(32)), function(byte) {
      return ('0' + (byte & 0xFF).toString(16)).slice(-2);
    }).join('')

    window.open(fs_origin+'#wallet/invoice='+id+"&address=${address}&amount=10")
  
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

        if (p.deposit_invoice) {
          r = await FS('invoice', {invoice: p.deposit_invoice})

          if (r.data.status == 'paid' && r.data.extra == id) {
            users[id] += r.data.amount
          } else {
            console.log('Not paid')
          }
          res.end(JSON.stringify({status: 'paid'}))
        } else if (p.destination) {
          var amount = parseInt(p.out_amount)
          if (users[id] < amount) {
            l('Not enough balance')
            return false
          }
          users[id] -= amount
          r = await FS('send', {
            outward: {
              destination: p.destination,
              amount: amount,
              invoice: 'from demo'
            }
          })
          l(r.data)
          res.end(JSON.stringify({status: 'paid'}))
        }
      })
    } else {
    }
  })
  .listen(3010)
