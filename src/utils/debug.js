// various debug methods for visual representation of a payment channel

prettyState = (state) => {
  if (!state[1]) return false
  state[1][2] = readInt(state[1][2])

  state[2].map((subch) => {
    subch[0] = readInt(subch[0])
    subch[1] = readInt(subch[1])

    // amount and exp, except the hash
    subch[2].map((h) => {
      h[0] = readInt(h[0])
      h[2] = readInt(h[2])
    })

    subch[3].map((h) => {
      h[0] = readInt(h[0])
      h[2] = readInt(h[2])
    })
  })
}

logstates = (reason, a, b, c, d, tr) => {
  l(`
=========${reason}

  Current state 
  ${ascii_state(a)}

  Their current state
  ${b ? ascii_state(b) : '-'}

  Our signed state
  ${ascii_state(c)}

  Their signed state
  ${ascii_state(d)}

  Transitions
  ${stringify(tr)}
=================

  `)
}

ascii_state = (state) => {
  if (!state[1]) return false
  let hash = toHex(sha3(r(state)))
  let locks = (hl) => {
    return hl
      .map((h) => h[0] + '/' + (h[1] ? trim(h[1]) : 'N/A') + '/' + h[2])
      .join(', ')
  }

  let list = state[2]
    .map((subch) => {
      return `${subch[0]}: ${subch[1]}
+${locks(subch[2])}
-${locks(subch[3])}
`
    })
    .join('')

  return `${trim(state[1][0])}-${trim(state[1][1])} | #${state[1][2]} (${trim(
    hash
  )})
-----
${list}
`
}

