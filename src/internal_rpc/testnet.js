module.exports = (p) => {
  if (p.action == 4) {
    me.CHEAT_dontack = 1
  } else if (p.action == 5) {
    me.CHEAT_dontreveal = 1
  } else if (p.action == 6) {
    me.CHEAT_dontwithdraw = 1
  } else {
    me.getCoins(p.asset, parseInt(p.faucet_amount))
    /*
    me.send(
      Members.find((m) => m.id == p.partner),
      'testnet',
      concat(bin([p.action, p.asset]), bin(me.address))
    )*/
  }

  let result = {confirm: 'Testnet action triggered'}

  return result
}
