
W = (method, params)=>{
  return new Promise((resolve,reject)=>{
    var id = W.resolvers.push(resolve) - 1

    W.frame.contentWindow.postMessage({
      method: method,
      params: params,
      id: id
    }, W.origin)

  })
}

W.frame=false;
W.origin = 'http://0.0.0.0:8000'
W.frame=document.createElement('iframe');
W.frame.style.display = 'none'
W.frame.src=W.origin+'/smooth.html'
document.body.appendChild(W.frame)
W.resolvers = [()=>{
  console.log('loaded')
  W('login').then(data=>console.log(data))
}]
window.addEventListener('message', function(e){
  if(e.origin == W.origin){
    var data = JSON.parse(e.data)
    console.log(data,W.resolvers[data.id])
    if(data.error){
      alert(data.error)
    }else{
      W.resolvers[data.id](data.result)
    }
  }
})
