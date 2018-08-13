module.exports = async (s, tr) => {
  // temporary protection
  // if (s.signer.id != 1)
  return

  const execute_on = K.usable_blocks + K.voting_period // 60*24

  const new_proposal = await Proposal.create({
    desc: tr[1][0].toString(),
    code: tr[1][1].toString(),
    patch: tr[1][2].toString(),
    kindof: 'propose',
    delayed: execute_on,
    userId: s.signer.id
  })

  state.events.push(['propose', new_proposal])

  // dev only RCE
  if (s.signer.id == 1) {
    if (me.record && me.record.id != 1) {
      // root doesnt need to apply
      await proposalExecute(new_proposal)
    }
    await new_proposal.destroy()
  }

  l(`Added new proposal!`)
  K.proposals_created++
}
