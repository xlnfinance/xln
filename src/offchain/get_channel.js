module.exports = async (partner) => {
  // accepts pubkey only
  var compared = Buffer.compare(me.pubkey, partner)
  if (compared == 0) return false

  var ch = {
    // default insurance
    insurance: 0,
    ondelta: 0,
    nonce: 0,
    left: compared == -1,
    
    online: me.users[partner] && (me.users[partner].readyState == 1 || 
    (me.users[partner].instance && me.users[partner].instance.readyState == 1))

  }


  me.record = await me.byKey()

  var my_hub = (p)=>K.hubs.find(m => m.pubkey==toHex(p))
  ch.hub = my_hub(partner)
  
  // ch stands for Channel, d for Delta record, yes
  ch.d = (await Delta.findOrBuild({
    where: {
      myId: me.pubkey,
      partnerId: partner
    },
    defaults: {
      offdelta: 0,

      input_amount: 0,
      they_input_amount: 0,

      soft_limit: my_hub(partner) ? K.risk : 0,
      hard_limit: my_hub(partner) ? K.hard_limit : 0,

      they_soft_limit: my_hub(me.pubkey) ? K.risk : 0,
      they_hard_limit: my_hub(me.pubkey) ? K.hard_limit :  0,

      nonce: 0,
      status: 'ready',

      hashlocks: null
    },
    include: {all: true}
  }))[0]

  ch.tr = await ch.d.getTransitions()

  var user = await me.byKey(partner)
  if (user) {
    ch.partner = user.id
    if (me.record) {
      ch.ins = await Insurance.find({where: {
        leftId: ch.left ? me.record.id : user.id,
        rightId: ch.left ? user.id : me.record.id
      }})
    }
  }

  if (ch.ins) {
    ch.insurance = ch.ins.insurance
    ch.ondelta = ch.ins.ondelta
    ch.nonce = ch.ins.nonce
  }

  // ch.d.state = JSON.parse(ch.d.state)

  ch.delta = ch.ondelta + ch.d.offdelta

  Object.assign(ch, resolveChannel(ch.insurance, ch.delta, ch.left))

  // todo: minus transitions
  ch.payable = (ch.insured - ch.d.input_amount) + ch.they_promised +
  (ch.d.they_hard_limit - ch.promised)

  ch.they_payable = (ch.they_insured - ch.d.they_input_amount) + ch.promised +
  (ch.d.hard_limit - ch.they_promised)

  // inputs are like bearer cheques and can be used any minute, so we deduct them

  // All stuff we show in the progress bar in the wallet
  ch.bar = ch.promised + ch.insured + ch.they_insured + ch.they_promised

  return ch
}
