

W = (method, params={})=>{
  return new Promise((resolve,reject)=>{
    var id = W.resolvers.push(resolve) - 1

    W.frame.contentWindow.postMessage({
      method: method,
      params: params,
      id: id,
      auth_code: localStorage.auth_code
    }, W.origin)

  })
}

var hash = location.hash.split('auth_code=')
if(hash[1]){
  localStorage.auth_code = hash[1].replace(/[^a-z0-9]/g,'')
  history.replaceState(null,null,'/')
}

W.frame=false;
W.origin = location.origin
W.frame=document.createElement('iframe');
W.frame.style.display = 'none'
W.frame.src=W.origin+'/sdk.html'
document.body.appendChild(W.frame)
W.onready = fn => {
  if(W.ready == true){
    fn()
  }else{
    W.ready = fn
  }
}
W.resolvers = [()=>{
  if(W.ready){
    W.ready()
    W.ready = true
  }
}]
window.addEventListener('message', function(e){
  if(e.origin == W.origin){
    var data = JSON.parse(e.data)

    W.resolvers[data.id](data.result)
    
  }
})
