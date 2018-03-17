// OLD demo to show our decentralization goals


var CSS_COLOR_NAMES = 'green yellow blue orange purple cyan magenta lime pink brown white black grey aqua maroon silver'.split(' ')
function getRandomColors (n) {
  var res = []
  for (var i = 0; i < n; i++) {
    res.push(CSS_COLOR_NAMES[Math.floor(Math.random() * CSS_COLOR_NAMES.length)])
  }
  return res
}

steps = []

steps[0] = [
  `This is how centralized services such as PayPal, E-Gold, LibertyReserve, or any bank or app that existed <a href="javascript:demoChart(1)">before Bitcoin appeared in 2009</a>.`,
    ['Server #1'], [100]
]

steps[1] = [`Then Bitcoin offered a way to disperse away authority from single server to many - this is dictionary definition of decentralization. In theory, electricity is fairly decentralized, unlike IP addresses. However, <a href="javascript:demoChart(2)">what you see on the chart is not how it actually worked out.</a>`,
  [], [] ]
for (var i = 1; i < 101; i++) {
  steps[1][1].push(`Miner #${i}`)
  steps[1][2].push(1)
}

/* As of  nov 2017
`{
  "Waterhole": 2,
  "GBMiners": 12,
  "BTC.TOP": 83,
  "Bitcoin India": 1,
  "Bixin": 19,
  "SlushPool": 60,
  "1Hash": 4,
  "BTCC Pool": 27,
  "BitFury": 24,
  "58COIN": 14,
  "AntPool": 117,
  "F2Pool": 55,
  "Unknown": 11,
  "BitClub Network": 13,
  "ViaBTC": 98,
  "BW.COM": 13,
  "KanoPool": 1,
  "BATPOOL": 1,
  "BTC.com": 95
}
`
*/

steps[2] = [`This is live result of hashrate distribution between major miners. It has been like this for a while: and there are no signs anything will change.<br> The most popular "strawman" argument is that the miners don't get to set the rules - well, no one ever said they need to. A double spend attack or large orphaned fork is enough to destroy the network.<br> Second argument to justify Proof-of-Work is that the "cost of attack" is very high and the attacker must do a very expensive (cost-of-attack, how scary!) operation to "outmine" existing players - <a href="javascript:attacker_fair()">we call it "fair" hijacking</a>. 

<p>That's not how security works, <b>as the saying goes you are as secure as your weakest link</b>, and that's exactly why in <a href="javascript:attacker_real(3)">the real hijacking the existing members will be attacked instead.</a></p>`]

fetch('https://api.blockchain.info/pools?cors=true&timespan=4days').then(r => r.json()).then(r => {
  sorted_keys = Object.keys(r).sort(function (a, b) { return r[b] - r[a] })

  var total = Object.values(r).reduce((t, k) => t + k)

  steps[2][1] = sorted_keys
  steps[2][2] = sorted_keys.map(k => (r[k] / total) * 100)
})

steps[3] = [`Then Bitcoin offered a way to disperse away authority from single server to many - this is dictionary definition of decentralization. In theory, electricity is fairly decentralized, unlike IP addresses. However, what you see on the chart is not how it actually worked out.`,
  [], [] ]

for (var i = 1; i < 301; i++) {
  steps[3][1].push(`Member #${i}`)
  steps[3][2].push(1)
}

attacker_fair = () => {
  chart.data.labels.push('Attacker')

  chart.data.datasets[0].backgroundColor.push('red')
  var id = chart.data.datasets[0].data.push(10) - 1

  chart.update()

  attack = () => {
    chart.data.datasets[0].data[id] += 20
    chart.update()
  }
  setTimeout(attack, 1000)
  setTimeout(attack, 2000)
  setTimeout(attack, 3000)
  setTimeout(attack, 4000)
  setTimeout(attack, 5000)
}

attacker_real = (top) => {
  if (chart.data.labels[chart.data.labels.length - 1] == 'Attacker') {
    chart.data.datasets[0].data.pop()
    chart.data.labels.pop()
    chart.data.datasets[0].backgroundColor.pop()
  }
  chart.update()

  for (var i = 0; i < top; i++) {
    chart.data.datasets[0].backgroundColor[i] = 'red'
    chart.data.labels[i] += ' (Hijacked)'
  }
  chart.update()
}

function demoChart (step) {
  var ctx = document.getElementById('decentChart').getContext('2d')
  var s = steps[step]
  if (this.chart) chart.destroy()
  this.chart = new Chart(ctx, {
    type: 'pie',
    data: {
      labels: s[1],
      datasets: [{
        data: s[2],
        backgroundColor: getRandomColors(s[2].length)
      }]
    },
    options: {
      legend: {
        display: false
      }
    }
  })

  decentText.innerHTML = s[0]
}
demoChart(0)
