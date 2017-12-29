var [Me] = require('./lib/me')

var u = new Me
u.init('u', Buffer.from('aa1649d94d6538904505bf233215072fa8bbcb958ec8306744337ec79cf935c5','hex')).then(()=>{
  l("Ready "+u.id.publicKey.toString('hex'))
})



me.broadcast('settleUser', rlp.encode([0, [], [2, 1, 1000]]))