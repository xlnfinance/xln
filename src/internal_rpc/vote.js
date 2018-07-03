module.exports = (p) => {
  me.batch.push(['vote', [p.id, p.approval, p.rationale]])

  let result = {confirm: 'Voted'}

  return result
}
