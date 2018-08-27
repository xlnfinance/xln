const Periodical = {
  consensus: require('../consensus'),

  syncChain: require('./sync_chain'),
  syncChanges: require('./sync_changes'),
  updateMetrics: require('./update_metrics'),
  updateCache: require('./update_cache'),
  rebalance: require('./rebalance'),
  ensureAck: require('./ensure_ack'),
  broadcast: require('./broadcast')
}

Periodical.schedule = function schedule(task, timeout) {
  if (me.scheduled[task]) {
    // clear if there's existing timeout and re-schedule
    clearTimeout(me.scheduled[task])
  }

  var wrap = async function() {
    //l('Start ', task)
    await Periodical[task]()
    me.scheduled[task] = setTimeout(wrap, timeout)
  }

  wrap()
}

Periodical.scheduleAll = function() {
  Periodical.schedule('consensus', 100)

  Periodical.schedule('syncChain', 4000)

  Periodical.schedule('updateMetrics', 1000)
  Periodical.schedule('updateCache', K.blocktime * 2000)

  Periodical.schedule('ensureAck', K.blocktime * 2000)

  if (me.my_hub || me.my_validator) {
    Periodical.schedule('syncChanges', K.blocktime * 2000)
  }

  if (me.my_hub) {
    // turn on auto rebalance with --rebalance
    //if (argv.rebalance) {
    Periodical.schedule('rebalance', K.blocktime * 2000)
    //}

    // hubs have to force react regularly
    setInterval(() => {
      react({})
    }, 15000)
  }
}

module.exports = Periodical
