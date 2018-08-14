module.exports = async (s, args) => {
  const [proposalId, approval, rationale] = args
  let vote = await Vote.findOrBuild({
    where: {
      userId: s.signer.id,
      proposalId: readInt(proposalId)
    }
  })

  vote = vote[0]
  vote.rationale = rationale.toString()
  vote.approval = approval[0] == 1

  await vote.save()
  s.parsed_tx.events.push(['vote', vote])
  l(`Voted ${vote.approval} for ${vote.proposalId}`)
}
