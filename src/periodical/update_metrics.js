module.exports = function() {
  for (let name of Object.keys(me.metrics)) {
    let m = me.metrics[name]
    m.total += m.current
    m.last_avg = Math.round(m.current)

    if (m.last_avg > m.max) {
      m.max = m.last_avg
    }
    m.avgs.push(m.last_avg)

    // free up memory
    if (m.avgs.length > 600) m.avgs.shift()

    m.current = 0 // zero the counter for next period
  }
}
