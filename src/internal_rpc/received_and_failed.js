module.exports = async () => {
  await me.syncdb()

  let result = {}

  // what we successfully received and must deposit in our app +
  // what node failed to send so we must deposit it back to user's balance
  result.receivedAndFailed = await Payment.findAll({
    where: {
      type: 'del',
      status: 'ack',
      processed: false,
      [Op.or]: [{is_inward: true}, {is_inward: false, secret: null}]
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
          [Op.or]: [{is_inward: true}, {is_inward: false, secret: null}]
        }
      }
    )
  }

  return result
}
