module.exports = () => {
  Periodical.syncChain()

  return {confirm: 'Syncing the chain...'}
}
