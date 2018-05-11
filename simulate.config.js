const {readdirSync} = require('fs')

let db = 'mysql:root:123123'

let walletPort = '26678'

let nodeFlags = ''
if (process.version.split('.')[0] === 'v10') {
  nodeFlags = '--experimental-repl-await'
}

// dataDirs = [8001, 8002, 8003, 8004]
let dataDirs = readdirSync(__dirname)
  .filter((d) => d.match(/^data.+/))
  .map((d) => d.replace(/^data/, ''))

module.exports = {
  apps: [
    {
      name: 'wallet',
      script: 'yarn',
      args: ['parcel', 'serve', 'wallet', '-p', walletPort]
    }
  ]
    .concat({
      name: 'fs',
      script: './fs.js',
      watch: false,
      autorestart: false,
      args: [
        '-p8433',
        '--wallet-url=http://localhost:' + walletPort,
        '--monkey=8008',
        '--db=' + db,
        '--CHEAT=dontprecommit',

        '--color' // `--color` for chalk
      ]
    })
    .concat(
      dataDirs.map((id) => ({
        name: 'fs' + id,
        script: './fs.js',
        watch: false,
        autorestart: false,
        args: [
          '-p' + id,
          '--username=' + id,
          '--pw=password',
          '--wallet-url=http://localhost:' + walletPort,
          '--datadir=data' + id,
          '--db=' + db,
          id < 8004 ? null : '--monkey=8008',
          id < 8004 ? null : '--silent',

          '--color' // `--color` for chalk
        ]
      }))
    )
}
