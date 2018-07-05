// various debug methods for visual representation of a payment channel

prettyState = (state) => {
  if (!state[1]) return false
  state[1][2] = readInt(state[1][2])
  state[1][3] = readInt(state[1][3])
  state[1][4] = readInt(state[1][4])

  // amount and exp, except the hash
  state[2].map((h) => {
    h[0] = readInt(h[0])
    h[2] = readInt(h[2])
  })

  state[3].map((h) => {
    h[0] = readInt(h[0])
    h[2] = readInt(h[2])
  })
}

logstates = (a, b, c, d) => {
  l('Our state\n', ascii_state(a))
  l('Our signed state\n', ascii_state(b))
  l('Their state\n', ascii_state(c))
  l('Their signed state\n', ascii_state(d))
}

ascii_state = (state) => {
  if (!state[1]) return false
  let hash = toHex(sha3(r(state)))

  let locks = (hl) => {
    return hl
      .map((h) => h[0] + '/' + (h[1] ? trim(h[1]) : 'N/A') + '/' + h[2])
      .join(', ')
  }

  return `Hash ${trim(hash)} | ${trim(state[1][0])}-${trim(state[1][1])} | #${
    state[1][2]
  } | ${state[1][3]} | \$${state[1][4]}
-----
+${locks(state[2])}
-----
-${locks(state[3])}
`
}

ascii_tr = (transitions) => {
  try {
    for (var t of transitions) {
      var m = methodMap(readInt(t[0]))

      if (m == 'add') {
        var info = `add ${readInt(t[1][0])} ${trim(t[1][1])} ${readInt(
          t[1][2]
        )} ${trim(t[1][3])}`
      } else {
        var info = `${m} ${trim(t[1][1])}`
      }
      l(`${info}`)
    }
  } catch (e) {}
}
