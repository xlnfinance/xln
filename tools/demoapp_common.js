
l=console.log


var fallback = setTimeout(()=>{
//main.innerHTML="Couldn't connect to local node at "+fs_origin+". <a href='https://fairlayer.com/#install'>Please install Fairlayer first</a>"
}, 3000)

window.onload = function(){
  deposit.innerHTML = address + '#' + id
  yourid.innerHTML = id

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
    fs_w = window.open(fs_origin+'#wallet?invoice='+id+'&address='+address+'&amount=10')

    window.addEventListener('message', function(e){
      if(e.origin != fs_origin) return

      if (e.data.status == 'paid') {
        fs_w.close()
        setTimeout(()=>{
          location.reload()
        }, 1000)
      }

    })
  }
}