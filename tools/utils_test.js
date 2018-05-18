require('../src/utils')

in_section = false
testq = async () => {
  if (in_section) throw 'Already in critical section'
  l('Entered critical section')
  in_section = true
  await sleep(10)
  in_section = false
  l('Left')
}

q('test', testq)
q('test', testq)
q('test', testq)
q('test', testq)
q('test', testq)

//test fees calculation
fees = [0.0000001, 0.000002, Math.random(), Math.random()]

for (var i = 0; i < 9999999; i++) {
  var am = i
  var after = afterFees(beforeFees(i, fees), fees.reverse())

  if (i != after) {
    console.log(i, after)
  }
}
