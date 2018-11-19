module.exports = async (ws) => {
  l('receivedAndFailed')
  //await Periodical.syncChanges()
  //return false

  let result = {}

  let filters = [
    {is_inward: true},
    {is_inward: false, outcome_type: {[Op.ne]: 'outcomeSecret'}}
  ]

  // what we successfully received and must deposit in our app +
  // what node failed to send so we must deposit it back to user's balance
  result.receivedAndFailed = await Payment.findAll({
    where: {
      type: 'del',
      status: 'ack',
      processed: false,
      [Op.or]: filters
    }
  })

  // mark as processed
  if (result.receivedAndFailed.length > 0) {
    await Payment.update(
      {processed: true},
      {
        where: {
          type: 'del',
          status: 'ack',
          [Op.or]: filters
        }
      }
    )
  }

  return result
}
