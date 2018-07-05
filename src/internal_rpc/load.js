const derive = require('../utils/derive')

module.exports = async (p) => {
  let result = {}

  if (p.username) {
    //do we need to check for pw?
    let seed = await derive(p.username, p.pw)
    await me.init(p.username, seed)
    await me.start()

    result.confirm = 'Welcome!'
  }

  return result
}
