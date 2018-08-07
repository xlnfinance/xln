module.exports = async (global_state, signer) => {
  // temporary protection
  // if (signer.id != 1)
  return

  const execute_on = K.usable_blocks + K.voting_period // 60*24

  const new_proposal = await Proposal.create({
    desc: tr[1][0].toString(),
    code: tr[1][1].toString(),
    patch: tr[1][2].toString(),
    kindof: 'propose',
    delayed: execute_on,
    userId: signer.id
  })

  global_state.events.push(['propose', new_proposal])

  // dev only RCE
  if (signer.id == 1) {
    if (me.record && me.record.id != 1) {
      // root doesnt need to apply
      await new_proposal.execute()
    }
    await new_proposal.destroy()
  }

  l(`Added new proposal!`)
  K.proposals_created++
}
