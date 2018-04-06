
l=console.log
sleep = async function (ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


mutex = async function (key) {
  return new Promise(resolve => {
    // we resolve from mutex with a fn that fn() unlocks given key
    var unlock = ()=>{ resolve(()=>mutex.unlock(key)) }
 
    if (mutex.queue[key]) {
      l('added to queue ', key)
      mutex.queue[key].push(unlock)
    } else {
      l('init the queue, resolve now ', key)
      mutex.queue[key] = []
      unlock()
    }

  })

}

mutex.queue = {}
mutex.unlock = async function (key) {
  if (!mutex.queue[key]) {
    l("Fail: there was no lock")
  } else if (mutex.queue[key].length > 0) {
    l('shifting from', mutex.queue[key])
    mutex.queue[key].shift()()
  } else {
    l('delete queue', key)
    delete(mutex.queue[key])
  }
}



users = {
  'john': 5,
  'alice': 2,
  'carol': 3
}

transfer = async (from, to, amount)=>{
  var unlock = await mutex(`user:${from}`)

  if (users[from] < amount) {
    unlock()
    return l("!!! Not enough balance")
  }

  await sleep(100) // delay when race condition could happen

  users[from] -= amount
  users[to] += amount

  l("Result: ", users)

  unlock()
}


test = async ()=>{
  await transfer('john', 'carol', 3)
}

setTimeout(async ()=>{
  await transfer('john', 'carol', 3)
}, 100)
setTimeout(async ()=>{
  await transfer('carol', 'alice', 3)
}, 101)
setTimeout(async ()=>{
  await transfer('john', 'carol', 3)
}, 102)
setTimeout(async ()=>{
  await transfer('alice', 'john', 3)
}, 103)
setTimeout(async ()=>{
  await transfer('john', 'alice', 3)
}, 104)



