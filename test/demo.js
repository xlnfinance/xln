// npm i axios cookies
axios = require('axios')
l = console.log
crypto = require('crypto')
rand = ()=>crypto.randomBytes(32).toString('hex')

Cookies = require('cookies')

users = {}

commy = (b,dot=true)=>{
  let prefix = b < 0 ? '-' : ''

  b = Math.abs(b).toString()
  if(dot){
    if(b.length==1){
      b='0.0'+b
    }else if(b.length==2){
      b='0.'+b
    }else{
      var insert_dot_at = b.length - 2
      b = b.slice(0,insert_dot_at) + '.' + b.slice(insert_dot_at)
    }
  }
  return prefix + b.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

require('http').createServer((req,res)=>{

  cookies = new Cookies(req,res)
  
  res.status = 200

  var id = cookies.get('id') 

  if(req.url == '/'){
    if(!id){
      id = rand()
      cookies.set('id', id)
    }
    if(!users[id]) users[id] = 0

    res.end(`
    <h1>Failsafe Demo</h1>

    <p>Hello, ${id}</p>
    <p>Balance: \$${commy(users[id])}</p>

    <html><body>
    <script src="https://unpkg.com/axios/dist/axios.min.js"></script>

<script>
FS = (method, params={})=>{
  return new Promise((resolve,reject)=>{
    var id = FS.resolvers.push(resolve) - 1

    FS.frame.contentWindow.postMessage({
      method: method,
      params: params,
      id: id
    }, FS.origin)

  })
}

var hash = location.hash.split('auth_code=')
if(hash[1]){
  localStorage.auth_code = hash[1].replace(/[^a-z0-9]/g,'')
  history.replaceState(null,null,'/#wallet')
}

FS.frame=false;
FS.origin = 'http://0.0.0.0:8001'
FS.frame=document.createElement('iframe');
FS.frame.style.display = 'none'
FS.frame.src=FS.origin+'/sdk.html'
document.body.appendChild(FS.frame)
FS.onready = fn => {
  if(FS.ready == true){
    fn()
  }else{
    FS.ready = fn
  }
}
FS.resolvers = [()=>{
  if(FS.ready){
    FS.ready()
    FS.ready = true
  }
}]
window.addEventListener('message', function(e){
  if(e.origin == FS.origin){
    var data = JSON.parse(e.data)

    FS.resolvers[data.id](data.result)
    
  }
})

</script>
<script>
//FYI sandbox="allow-scripts allow-modals" won't bypass it btw

window.onload = function(){
  donat.onclick = function(){
    axios.post('/init', {
      amount: parseFloat(amount.value)*100
    }).then(r=>{
      console.log(r)
      FS('pay', r.data).then(data=>{
        if(data.status == 'paid'){
          // server can receive it later
          setTimeout(()=>{


            axios.post('/init', {
              invoice: r.data.invoice
            }).then((r2)=>{

              console.log(r2.data)

              location.reload()
            })
          }, 500)

        }
      })
 
    })
  }
}
</script>

<div id="zone">
  <input id=amount placeholder="$ Amount">
  <button width="200px" id="donat">Deposit</button
</div>

</body></html>



      `)
  }else if(req.url == '/init'){
    var queryData = ''
    req.on('data', function(data) { queryData += data })

    req.on('end', function() {
      var p = JSON.parse(queryData)

      if(p.invoice){
        l(p.invoice)
        axios.post('http://0.0.0.0:8002/invoice', {
          invoice: p.invoice
        }).then(r=>{ 
          l('got invoice', r)
          if(r.data.status == 'paid'){
            users[id] += r.data.amount
          }else{
            console.log('Expired')
          }
          res.end(JSON.stringify({status: 'paid'})) 
        })

      }else{ 
        l(req.url)
        axios.post('http://0.0.0.0:8002/invoice', {
          amount: p.amount,
          extra: 'uid'
        }).then(r=>{ 
          res.end(JSON.stringify(r.data)) 
        })
      }


    })



  }else{
    l('Not found '+req.url)
  }


}).listen(3010)