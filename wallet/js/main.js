import Vue from 'vue'

import Trend from 'vuetrend'
Vue.use(Trend)

import App from './App'

window.jQuery = require('../assets/assets/js/vendor/jquery-slim.min.js')
window.Popper = require('../assets/assets/js/vendor/popper.min.js')
require('../assets/dist/js/bootstrap.min.js')

window.Tour = require('./shepherd.min.js')

window.l = console.log
window.ts = () => Math.round(new Date() / 1000)

document.title = 'Fair ' + location.port

window.hashargs = location.hash
  ? location.hash
      .slice(1)
      .split('&')
      .map((el) => el.split('='))
      .reduce((pre, cur) => {
        pre[cur[0]] = cur[1]
        return pre
      }, {})
  : {}

if (hashargs.auth_code) {
  localStorage.auth_code = hashargs.auth_code.replace(/[^a-z0-9]/g, '')
  history.replaceState(null, null, '/#wallet')
}

if (opener) {
  // let the opener know this machine has fair installed
  opener.postMessage({status: 'loaded'}, '*')
}

String.prototype.hexEncode = function() {
  var hex, i

  var result = ''
  for (i = 0; i < this.length; i++) {
    hex = this.charCodeAt(i).toString(16)
    result += ('0' + hex).slice(-2)
  }

  return result
}

window.renderRisk = (hist) => {
  var precision = 100 // devide time by

  if (!window.riskchart) {
    var ctx = riskcanvas.getContext('2d')
    ctx.height = '400px'
    ctx.width = '100%'

    window.riskchart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Uninsured',
            steppedLine: true,
            data: [{x: Math.round(new Date() / precision), y: 0}],
            borderColor: 'rgb(220, 53, 69)',
            backgroundColor: 'rgb(220, 53, 69)'
          }
        ]
      },
      options: {
        legend: {
          display: false
        },

        maintainAspectRatio: false,
        // responsive: false,

        title: {
          display: true
        },
        scales: {
          xAxes: [
            {
              type: 'linear',
              position: 'bottom',
              labelString: 'Time'
            }
          ],
          yAxes: [
            {
              ticks: {
                suggestedMin: 0,
                suggestedMax: 1000,
                mirror: true
              }
            }
          ]
        }
      }
    })
  }

  var d = window.riskchart.data.datasets[0].data

  var last = d.pop()

  if (hist.length == 0) return false
  var hist = hist
    .slice()
    .reverse()
    .slice(d.length)

  for (h of hist) {
    d.push({
      x: Math.round(Date.parse(h.date) / precision),
      // for now we hide the spent dynamics to not confuse the user
      y: Math.round(h.delta / 100)
    })
  }

  // keep it updated
  d.push({
    x: Math.round(new Date() / precision),
    y: d[d.length - 1].y
  })

  window.riskchart.update()
}

window.prefillUsername = () => {
  let word = 'demo' + Math.round(Math.random() * 1000000)
  for (let i = 0; i < word.length; i++) {
    setTimeout(() => {
      window.app.username += word[i]
    }, i * 100)
  }
  let word2 = 'password'
  for (let i = 0; i < word2.length; i++) {
    setTimeout(() => {
      window.app.pw += word2[i]
    }, 1200 + i * 100)
  }
  prefillUsername = false
}
window.render = (r) => {
  if (!r) {
    l('Broken render obj', r)
    return false
  }

  let firstLoad = !app.pubkey
  if (r.alert) notyf.alert(r.alert)
  if (r.confirm) notyf.confirm(r.confirm)

  // show step from tour
  if (r.showStep) window.tour.show(r.showStep)

  if (r.reload) {
    clearInterval(window.app.interval)

    document.body.innerHTML = 'Reload requested'
    // only reload when the server is alive again
    setInterval(() => {
      fetch('/').then((r) => {
        location.reload()
      })
    }, 1000)
    return false
  }

  if (r.already_opened) {
    clearInterval(window.app.interval)

    document.body.innerHTML =
      '<b>The wallet was opened in another tab. Reload to continue in this tab.</b>'
    return false
  }

  // verify if opener-initiated last hashargs payment succeded (we know secret for this invoice)

  if (opener && r.payment_outcome == 'success') {
    l('Pinging parent')
    opener.postMessage({status: 'paid'}, '*')
  }

  if (r.payments && r.payments.length != app.payments.length) {
    app.updateRoutes()
  }

  Object.assign(window.app, r)
  window.app.$forceUpdate()

  if (firstLoad && location.hostname.startsWith('demo-') && prefillUsername) {
    prefillUsername()
  }

  // go add hubs if logged in & no channels exist
  if (
    firstLoad &&
    app.pubkey &&
    app.tab == 'wallet' &&
    app.channels.length == 0
  ) {
    //app.go('hubs')
  }

  if (r.history && window.riskcanvas) {
    renderRisk(r.history)
  }
}

function WebSocketClient() {
  this.number = 0 // Message number
  this.autoReconnectInterval = 5 * 1000 // ms
}
WebSocketClient.prototype.open = function(url) {
  this.url = url
  this.instance = new WebSocket(this.url)

  this.instance.addEventListener('open', () => {
    this.onopen()
  })
  this.instance.addEventListener('message', (data, flags) => {
    this.number++
    this.onmessage(data, flags, this.number)
  })
  this.instance.addEventListener('close', (e) => {
    switch (e) {
      case 1000: // CLOSE_NORMAL
        console.log('WebSocket: closed')
        break
      default:
        // Abnormal closure
        this.reconnect(e)
        break
    }
    this.onclose(e)
  })
  this.instance.addEventListener('error', (e) => {
    switch (e.code) {
      case 'ECONNREFUSED':
        this.reconnect(e)
        break
      default:
        this.onerror(e)
        break
    }
  })
}
WebSocketClient.prototype.send = function(data) {
  if (this.instance && this.instance.readyState != 1) {
    //l("Socket is not ready")
    return false
  }

  try {
    //var port = this.url.split(':')[2]
    //l('I SEND ' + data.length + ' TO ' + port)
    this.instance.send(data)
    return true
  } catch (e) {
    l('Failed to send ws:', e)
    return false
    //this.instance.emit('error', e)
  }
}

WebSocketClient.prototype.reconnect = function(e) {
  // console.log(`WebSocketClient: retry in ${this.autoReconnectInterval}ms`);
  //this.instance.removeAllListeners()
  app.online = false
  var that = this
  setTimeout(function() {
    that.open(that.url)
  }, this.autoReconnectInterval)
}
WebSocketClient.prototype.onopen = function(e) {
  console.log('WebSocketClient: open', arguments)
}
WebSocketClient.prototype.onmessage = function(data, flags, number) {
  // console.log("WebSocketClient: message",arguments);
}
WebSocketClient.prototype.onerror = function(e) {
  console.log('WS error  ', e)
}
WebSocketClient.prototype.onclose = function(e) {
  // console.log('WebSocketClient: closed', arguments)
}

window.FS = (method, params = {}) => {
  return new Promise((resolve, reject) => {
    FS.ws.send(
      JSON.stringify({
        method: method,
        params: params,
        id: 1,
        auth_code: localStorage.auth_code,
        is_wallet: true // not all internal_rpc clients are wallets
      })
    )
  })
}

FS.ws = new WebSocketClient()
FS.ws.open((location.protocol == 'http:' ? 'ws://' : 'wss://') + location.host)

FS.ws.onmessage = (m) => {
  var data = JSON.parse(m.data)
  render(data)
}

FS.ws.onopen = () => {
  app.online = true

  window.notyf = new Notyf({delay: 4000})

  // App is available as `window.app`
  new Vue({
    el: '#app',
    render: (h) => h(App)
  })
}
