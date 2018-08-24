module.exports = async (args) => {
  let action = readInt(args[0])

  var friendly_invoice = [
    'You are welcome!',
    'With great power comes great responsibility',
    "It's free money!",
    'Call me maybe?',
    "'\"><img src=x onerror=alert('pwned')>",
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  ].randomElement()

  if (action == 1) {
    let asset = readInt(args[1])
    let amount = readInt(args[2])
    let pay = {
      address: args[3],
      amount: amount,
      invoice: friendly_invoice,
      asset: asset
    }

    l('testnet', pay)
    await me.payChannel(pay)
  }
}
