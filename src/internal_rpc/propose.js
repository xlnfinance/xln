module.exports = (p) => {
  if (p[0].length <= 1) throw 'Rationale is required'

  if (p[2]) {
    // for some reason execSync throws but gives result
    try {
      // exclude all non-JS files for now
      p[2] = child_process.execSync(
        'diff  -Naur --exclude=*{.cache,data,dist,node_modules,private,spec,.git}  ../8001 . '
      )
    } catch (err) {
      p[2] = err.stdout
    }
  }

  me.batch.push(['propose', p])
  let result = {confirm: 'Proposed'}

  return result
}
