import Vue from 'vue'

import App from './App'

window.jQuery = require('../assets/assets/js/vendor/jquery-slim.min.js')
window.Popper = require('../assets/assets/js/vendor/popper.min.js')
require('../assets/dist/js/bootstrap.min.js')

window.l = console.log
window.ts = () => Math.round(new Date() / 1000)

window.hashargs = location.hash.split('/')[1]

hashargs = hashargs
  ? hashargs
      .split('&')
      .map((el) => el.split('='))
      .reduce((pre, cur) => {
        pre[cur[0]] = cur[1]
        return pre
      }, {})
  : {}

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
            data: [{ x: Math.round(new Date() / precision), y: 0 }],
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

window.render = (r) => {
  if (r.alert) notyf.alert(r.alert)
  if (r.confirm) notyf.confirm(r.confirm)

  if (r.already_opened) {
    document.body.innerHTML =
      '<b>The wallet is already opened in another tab. Only one instance of wallet is allowed.</b>'
    return false
  }

  Object.assign(window.app, r)
  window.app.$forceUpdate()

  if (r.history && window.riskcanvas) {
    renderRisk(r.history)
  }
}

FS.resolvers.push(render)

FS.onready(() => {

  window.notyf = new Notyf({delay: 4000})

  // App is available as `window.app`
  new Vue({
    el: '#app',
    render: (h) => h(App),
  })
})
