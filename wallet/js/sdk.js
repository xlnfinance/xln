// controls tiny iframe that talks to localhost daemon
FS = (method, params = {}) => {
  return new Promise((resolve, reject) => {
    var id = FS.resolvers.push(resolve) - 1

    FS.frame.contentWindow.postMessage({
      method: method,
      params: params,
      id: id,
      auth_code: localStorage.auth_code
    }, FS.origin)
  })
}

var hash = location.hash.split('auth_code=')
if (hash[1]) {
  localStorage.auth_code = hash[1].replace(/[^a-z0-9]/g, '')
  history.replaceState(null, null, '/#wallet')
}

FS.frame = false
FS.origin = location.origin
FS.frame = document.createElement('iframe')
FS.frame.style.display = 'none'
FS.frame.src = FS.origin + '/sdk.html'
document.body.appendChild(FS.frame)
FS.onready = fn => {
  if (FS.ready == true) {
    fn()
  } else {
    FS.ready = fn
  }
}
FS.resolvers = [() => {
  if (FS.ready) {
    FS.ready()
    FS.ready = true
  }
}]
window.addEventListener('message', function (e) {
  if (e.origin == FS.origin) {
    var data = JSON.parse(e.data)
    FS.resolvers[data.id](data.result)
  }
})
