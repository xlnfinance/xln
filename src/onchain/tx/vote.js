module.exports = async (global_state, tr, signer) => {
  const [proposalId, approval, rationale] = tr[1]
  let vote = await Vote.findOrBuild({
    where: {
      userId: signer.id,
      proposalId: readInt(proposalId)
    }
  })

  vote = vote[0]
  vote.rationale = rationale.toString()
  vote.approval = approval[0] == 1

  await vote.save()
  global_state.events.push(['vote', vote])
  l(`Voted ${vote.approval} for ${vote.proposalId}`)
}
