const derive = require('../utils/derive')

module.exports = async (p) => {
  //do we need to check for pw?
  let seed = await derive(p.username, p.pw)
  await me.init(p.username, seed)
  await me.start()

  /*
  await Event.create({
    desc: 'You just joined the network. Click faucet to get some free assets.'
  })
  */

  l('Logging in...')

  react({
    confirm: 'Click faucet to get some free assets.',
    public: true,
    private: true,
    force: true
  })
}
