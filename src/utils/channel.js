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
    if (amount > 0) {
      return Array(1 + Math.ceil((amount * 100) / total)).join(symbol)
    } else {
      return ''
    }
  }

  // visual representations of state in ascii and text
  /*
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
  */

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

const paymentToLock = (payment) => {
  return [payment.amount, payment.hash, payment.exp]
}

refresh = function(ch) {
  // Canonical state.
  // To be parsed in case of a dispute onchain
  ch.state = [
    methodMap('disputeWith'),
    [
      ch.d.isLeft() ? ch.d.myId : ch.d.partnerId,
      ch.d.isLeft() ? ch.d.partnerId : ch.d.myId,
      ch.d.dispute_nonce
    ],
    // assetId, offdelta, leftlocks, rightlocks
    []
  ]

  for (let subch of ch.d.subchannels) {
    let out = {
      inwards: [],
      outwards: [],
      hashlock_hold: [0, 0],
      asset: subch.asset,
      subch: subch
    }
    // find the according subinsurance for subchannel
    let subins
    if (ch.ins && ch.ins.subinsurances) {
      subins = ch.ins.subinsurances.by('asset', subch.asset)
    }
    if (!subins) subins = {balance: 0, ondelta: 0}

    // hashlock creates hold-like assets in limbo. For left and right user:

    for (let i = 0; i < ch.payments.length; i++) {
      let t = ch.payments[i]

      if (t.asset != subch.asset) continue

      var typestatus = t.type + t.status

      if (
        [
          'addack',
          'delnew',
          ch.d.rollback_nonce > 0 ? 'delsent' : 'addsent'
        ].includes(typestatus)
      ) {
        out[t.is_inward ? 'inwards' : 'outwards'].push(t)
        out.hashlock_hold[t.is_inward ? 0 : 1] += t.amount
      }
    }

    // we must apply withdrawal proofs on state even before they hit blockchain
    // what we are about to withdraw and they are about to withdraw
    let insurance =
      subins.balance - subch.withdrawal_amount + subch.they_withdrawal_amount
    // TODO: is it correct?
    //delta minus what Left one is about to withdraw
    let delta =
      subins.ondelta +
      subch.offdelta -
      (ch.d.isLeft() ? subch.withdrawal_amount : subch.they_withdrawal_amount)

    Object.assign(out, resolveChannel(insurance, delta, ch.d.isLeft()))

    // inputs are like bearer cheques and can be used any minute, so we deduct them
    out.payable =
      out.insured +
      out.uninsured +
      subch.they_hard_limit -
      out.they_uninsured -
      out.hashlock_hold[1]

    out.they_payable =
      out.they_insured +
      out.they_uninsured +
      subch.hard_limit -
      out.uninsured -
      out.hashlock_hold[0]

    // All stuff we show in the progress bar in the wallet
    out.bar =
      out.they_uninsured + out.insured + out.they_insured + out.uninsured

    ch.state[2].push([
      subch.asset,
      subch.offdelta,
      out[ch.d.isLeft() ? 'inwards' : 'outwards'].map((t) => paymentToLock(t)),
      out[ch.d.isLeft() ? 'outwards' : 'inwards'].map((t) => paymentToLock(t))
    ])

    ch.derived[subch.asset] = out
  }

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
  if (!obj.id) {
    await obj.save()
  }

  if (obj.balances) {
    for (let b of obj.balances) {
      b.userId = obj.id
      if (b.changed()) await b.save()
    }
  }

  if (obj.subinsurances) {
    for (let b of obj.subinsurances) {
      // create ref later
      b.insuranceId = obj.id
      //l('saved subins', b)

      if (b.changed()) await b.save()
    }
  }
}
