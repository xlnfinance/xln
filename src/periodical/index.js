const Periodical = {
  consensus: require('../consensus'),

  syncChain: require('./sync_chain'),
  syncChanges: require('./sync_changes'),
  updateMetrics: require('./update_metrics'),
  updateCache: require('./update_cache'),
  rebalance: require('./rebalance'),
  ensureAck: require('./ensure_ack'),
  broadcast: require('./broadcast'),
  forceReact: () => {
    react({})
  },

  timeouts: {}
}

Periodical.schedule = function schedule(task, timeout) {
  if (Periodical.timeouts[task]) {
    // clear if there's existing timeout and re-schedule
    clearTimeout(Periodical.timeouts[task])
    delete Periodical.timeouts[task]
  }

  if (timeout == 0) return

  var wrap = async function() {
    //l('Start ', task)
    await Periodical[task]()
    Periodical.timeouts[task] = setTimeout(wrap, timeout)
  }

  wrap()
}

Periodical.startValidator = () => {
  l('Starting validator ', me.my_validator)
  me.startExternalRPC(me.my_validator.location)
  Periodical.schedule('consensus', 200)
}

Periodical.startHub = () => {
  //if (!me.external_wss_server){
  l('Starting hub ', me.my_hub)
  me.startExternalRPC(me.my_hub.location)
  //Periodical.schedule('syncChanges', K.blocktime * 4000)
  Periodical.schedule('rebalance', K.blocktime * 2000)

  // hubs have to force react regularly
  Periodical.schedule('forceReact', K.blocktime * 3000)
  //}
}

Periodical.scheduleAll = function() {
  Periodical.schedule('syncChanges', K.blocktime * 2000)

  Periodical.schedule('updateMetrics', 1000)
  Periodical.schedule('updateCache', K.blocktime * 1000)

  //Periodical.schedule('ensureAck', K.blocktime * 2000)
}

module.exports = Periodical
