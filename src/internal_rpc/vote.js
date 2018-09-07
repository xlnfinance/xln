module.exports = (p) => {
  me.batchAdd('vote', [p.id, p.approval, p.rationale])

  let result = {confirm: 'Voted'}

  return result
}
