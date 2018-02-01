var fs = require('../fs')
var Me = require('../lib/me').Me

// simulate 1m users randomly transacting with each other...

var u = []
for (var i = 0; i < 100; i++) {
  u[i] = new Me()
  var b = Buffer.alloc(32)
  b.writeInt32BE(i)

  u[i].init('u' + i, b).then(() => {
    l('Ready ' + u[i].id.publicKey.toString('hex'))
  })
}
