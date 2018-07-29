// Defines how payment channels work, based on "insurance" and delta=(ondelta+offdelta)
// There are 3 major scenarios of delta position
// . is 0 point, | is delta, = is insured, - is uninsured
// 4,6  .====--| (left user owns entire insurance, has 2 uninsured)
// 4,2  .==|==   (left and right both have 2 insured)
// 4,-2 |--.==== (right owns entire insurance, 2 in uninsured balance)
// https://codepen.io/anon/pen/wjLGgR visual demo
resolveChannel = (insurance, delta, is_left = true) => {
  if (!Number.isInteger(insurance) || !Number.isInteger(delta)) {
    l(insurance, delta)
    throw 'Not integer'
  }

  var parts = {
    // left user promises only with negative delta, scenario 3
    they_uninsured: delta < 0 ? -delta : 0,
    insured: delta > insurance ? insurance : delta > 0 ? delta : 0,
    they_insured:
      delta > insurance ? 0 : delta > 0 ? insurance - delta : insurance,
    // right user promises when delta > insurance, scenario 1
    uninsured: delta > insurance ? delta - insurance : 0
  }

  var total =
    parts.they_uninsured + parts.uninsured + parts.they_insured + parts.insured

  if (total < 100) total = 100

  var bar = (amount, symbol) => {
    if (amount == 0) return ''
    return Array(1 + Math.ceil((amount * 100) / total)).join(symbol)
  }

  // visual representations of state in ascii and text
  if (delta < 0) {
    parts.ascii_channel =
      '|' + bar(parts.they_uninsured, '-') + bar(parts.they_insured, '=')
  } else if (delta < insurance) {
    parts.ascii_channel =
      bar(parts.insured, '=') + '|' + bar(parts.they_insured, '=')
  } else {
    parts.ascii_channel =
      bar(parts.insured, '=') + bar(parts.uninsured, '-') + '|'
  }

  // default view is left. if current user is right, simply reverse
  if (!is_left) {
    ;[
      parts.they_uninsured,
      parts.insured,
      parts.they_insured,
      parts.uninsured
    ] = [
      parts.uninsured,
      parts.they_insured,
      parts.insured,
      parts.they_uninsured
    ]
  }

  return parts
}

refresh = function(ch) {
  // filter all payments by some trait
  ch.inwards = []
  ch.outwards = []

  // hashlock creates hold-like assets in limbo. For left and right user:
  ch.hashlock_hold = [0, 0]

  for (let i = 0; i < ch.payments.length; i++) {
    let t = ch.payments[i]

    var typestatus = t.type + t.status

    if (
      ['addack', 'delnew', ch.rollback[0] > 0 ? 'delsent' : 'addsent'].includes(
        typestatus
      )
    ) {
      ch[t.is_inward ? 'inwards' : 'outwards'].push(t)
      ch.hashlock_hold[t.is_inward ? 0 : 1] += t.amount
    }
  }

  let insurance = ch.ins.insurance
  let delta = ch.ins.ondelta + ch.d.offdelta

  // we must apply withdrawal proofs on state even before they hit blockchain
  // what we are about to withdraw and they are about to withdraw
  insurance -= ch.d.withdrawal_amount + ch.d.they_withdrawal_amount

  // delta minus what Left one is about to withdraw
  delta -= ch.left ? ch.d.withdrawal_amount : ch.d.they_withdrawal_amount

  Object.assign(ch, resolveChannel(insurance, delta, ch.left))

  // Canonical state
  ch.state = [
    methodMap('disputeWith'),
    [
      ch.left ? ch.d.myId : ch.d.partnerId,
      ch.left ? ch.d.partnerId : ch.d.myId,
      ch.d.nonce,
      ch.d.offdelta,
      ch.d.asset
    ],
    ch[ch.left ? 'inwards' : 'outwards'].map((t) => t.toLock()),
    ch[ch.left ? 'outwards' : 'inwards'].map((t) => t.toLock())
  ]

  // inputs are like bearer cheques and can be used any minute, so we deduct them
  ch.payable =
    ch.insured +
    ch.uninsured +
    ch.d.they_hard_limit -
    ch.they_uninsured -
    ch.hashlock_hold[1]

  ch.they_payable =
    ch.they_insured +
    ch.they_uninsured +
    ch.d.hard_limit -
    ch.uninsured -
    ch.hashlock_hold[0]

  // All stuff we show in the progress bar in the wallet
  ch.bar = ch.they_uninsured + ch.insured + ch.they_insured + ch.uninsured

  ch.ascii_states = ascii_state(ch.state)
  if (ch.d.signed_state) {
    let st = r(ch.d.signed_state)
    prettyState(st)
    st = ascii_state(st)
    if (st != ch.ascii_states) {
      ch.ascii_states += st
    }
  }

  return ch.state
}

saveId = async function(obj) {
  // only save if it has no id now
  if (!obj.id) await obj.save()
}
