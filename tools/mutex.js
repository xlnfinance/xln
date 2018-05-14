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
