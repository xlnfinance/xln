const Periodical = require('../periodical')
module.exports = () => {
  Periodical.syncChain()

  let result = {confirm: 'Syncing the chain...'}

  return result
}
