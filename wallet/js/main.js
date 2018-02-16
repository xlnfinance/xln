
l = console.log
ts = () => Math.round(new Date() / 1000)

renderRisk = (hist) => {
  if (hist.length == 0) return false

  var precision = 100 // devide time by 

  if (!window.riskchart) {
    window.riskchart = new Chart(riskcanvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Uninsured',
          steppedLine: true,
          data: [{x: Math.round(new Date/precision), y: 0}],
          borderColor: 'rgb(220, 53, 69)',
          backgroundColor: 'rgb(220, 53, 69)'
        }]
      },
      options: {
        // responsive: true,
        title: {
          display: true,
          text: 'Risk analytics'
        },
        scales: {
          xAxes: [{
            type: 'linear',
            position: 'bottom',
            labelString: 'Time'
          }],
          yAxes: [{
            ticks: {
              suggestedMin: 0,
              suggestedMax: 1000,
              mirror: true
            }
          }]
        }
      }
    })
  }

  var d = window.riskchart.data.datasets[0].data

  var last = d.pop()

  var hist = hist.slice().reverse().slice(d.length)

  for (h of hist) {
    d.push({
      x: Math.round(Date.parse(h.date)/precision),
      // for now we hide the spent dynamics to not confuse the user
      y: (h.rdelta < 0) ? 0 : Math.round(h.rdelta/100)
    })
  }

  // keep it updated
  d.push({
    x: Math.round(new Date/precision),
    y: d[d.length - 1].y
  })

  window.riskchart.update()
}

render = r => {
  if (r.alert) notyf.alert(r.alert)
  if (r.confirm) notyf.confirm(r.confirm)

  Object.assign(app, r)
  app.$forceUpdate()

  if (r.history && window.riskcanvas) {
    renderRisk(r.history)
  }
}

FS.resolvers.push(render)

FS.onready(() => {
  FS('load').then(render)

  if (localStorage.auth_code) {
    // local node
    if (location.hash == '') location.hash = '#wallet'

    setInterval(function () {
      FS('load').then(render)
    }, 3000)
  }

  notyf = new Notyf({delay: 4000})

  var methods = {
    icon: (h, s) => {
      return '<img width=' + s + ' height=' + s + ' src="data:image/png;base64,' + (new Identicon(h.toString(), s).toString()) + '">'
    },
    hljs: hljs.highlight,

    ivoted: (voters) => {
      return voters.find(v => v.id == app.record.id)
    },

    toHexString: (byteArray) => {
      return Array.prototype.map.call(byteArray, function (byte) {
        return ('0' + (byte & 0xFF).toString(16)).slice(-2)
      }).join('')
    },

    call: function (method, args) {
      if (method == 'vote') {
        args.rationale = prompt('Why?')
        if (!args.rationale) return false
      }

      FS(method, args).then(render)
      return false
    },
    rebalance: () => {
      var total = app.outs.reduce((k, v) => k + parseFloat(v.amount.length == 0 ? '0' : v.amount), 0)

      // if(confirm("Total outputs: $"+app.commy(total)+". Do you want to broadcast your transaction?")){
      app.call('rebalanceUser', {
        asset: 0,
        ins: app.ins,
        outs: app.outs
      })
      // }
    },
    derive: f => {
      var data = {
        username: inputUsername.value,
        password: inputPassword.value
      }

      FS('load', data).then(render)
      return false
    },

    off_amount_full: () => {
      var before = app.uncommy(app.off_amount)
      var fee = Math.round(before / 999)
      if (fee == 0) fee = 1
      return app.commy(before + fee)
    },

    dispute: () => {
      var fee = app.commy(app.K.standalone_balance)
      if (app.record) {
        if (app.record.balance >= app.K.standalone_balance) {
          if (confirm('Transaction fee is $' + fee + '. Proceed and start onchain dispute?')) {
            app.call('takeEverything')
          }
        } else {
          alert("You don't have enough global balance. You need at least " + fee)
        }
      } else {
        alert('You are not registred onchain yet. Ensure to receive at list $' + app.commy(K.risk) + ', or be registred by other users.')
      }
    },

    go: (path) => {
      if (path == '') {
        history.pushState('/', null, '/')
      } else {
        location.hash = '#' + path
      }
      app.tab = path
    },

    deltaColor: (d) => {
      if (d <= -app.K.risk) return '#ff6e7c'
      if (d >= app.K.risk) return '#5ed679'

      return ''
    },

    commy: (b, dot = true) => {
      let prefix = b < 0 ? '-' : ''

      b = Math.abs(b).toString()
      if (dot) {
        if (b.length == 1) {
          b = '0.0' + b
        } else if (b.length == 2) {
          b = '0.' + b
        } else {
          var insert_dot_at = b.length - 2
          b = b.slice(0, insert_dot_at) + '.' + b.slice(insert_dot_at)
        }
      }
      return prefix + b.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    },
    uncommy: str => {
      if (str.indexOf('.') == -1) str += '.00'

      return parseInt(str.replace(/[^0-9]/g, ''))
    },

    unpackInvoice: () => {
      var i = app.pay_invoice.split('_')

      return {
        amount: i[0],
        userId: i[1],
        hubId: i[2],
        invoice: i[3],
        trimmedId: i[1].length == 64 ? i[1].substr(0,10)+'...' : i[1]
      }
    },

    timeAgo: (time) => {
      var units = [
        { name: 'second', limit: 60, in_seconds: 1 },
        { name: 'minute', limit: 3600, in_seconds: 60 },
        { name: 'hour', limit: 86400, in_seconds: 3600 },
        { name: 'day', limit: 604800, in_seconds: 86400 },
        { name: 'week', limit: 2629743, in_seconds: 604800 },
        { name: 'month', limit: 31556926, in_seconds: 2629743 },
        { name: 'year', limit: null, in_seconds: 31556926 }
      ]
      var diff = (new Date() - new Date(time * 1000)) / 1000
      if (diff < 5) return 'now'

      var i = 0, unit
      while (unit = units[i++]) {
        if (diff < unit.limit || !unit.limit) {
          var diff = Math.floor(diff / unit.in_seconds)
          return diff + ' ' + unit.name + (diff > 1 ? 's' : '') + ' ago'
        }
      };
    }

  }

  var wp = app.innerHTML

  app = new Vue({
    el: '#app',
    data () {
      return {
        auth_code: localStorage.auth_code,
        asset: 'FSD',
        whitepaper: wp,

        pubkey: false,
        K: false,
        my_member: false,

        pw: '',
        username: '',

        channels: {},

        record: false,

        tab: location.hash.substr(1),

        install_snippet: false,

        ins: [],
        outs: [{to: '', amount: ''}],

        off_to: '',
        off_amount: '',
        is_hub: false,

        history: [],

        proposal: ['Mint $1000 FSD to 1@1', `await Tx.mint(0, 1, 1, 100000)`, ''],


        new_invoice: '',
        pay_invoice: ''

      }
    },
    methods: methods,
    template: `
<div>
  <nav class="navbar navbar-expand-md navbar-light bg-faded mb-4">

    <a class="navbar-brand" href="#">Failsafe</a>
    <button class="navbar-toggler" type="button" data-toggle="collapse" data-target="#navbarCollapse" aria-controls="navbarCollapse" aria-expanded="false" aria-label="Toggle navigation">
      <span class="navbar-toggler-icon"></span>
    </button>


    <div class="collapse navbar-collapse" id="navbarCollapse">
      <ul class="navbar-nav mr-auto">

        <li class="nav-item" v-bind:class="{ active: tab=='' }">
          <a class="nav-link" @click="go('')">Whitepaper</a>
        </li>

        <li v-if="auth_code" class="nav-item" v-bind:class="{ active: tab=='wallet' }">
          <a class="nav-link" @click="go('wallet')">Wallet</a>
        </li>


        <li v-if="auth_code && record" class="nav-item" v-bind:class="{ active: tab=='rebalance' }">
          <a class="nav-link" @click="go('rebalance')">Settlement</a>
        </li>




        <li class="nav-item"  v-bind:class="{ active: tab=='gov' }">
          <a class="nav-link" @click="go('gov')">Governance</a>
        </li>



        <li v-if="my_member" class="nav-item" v-bind:class="{ active: tab=='install' }">
          <a class="nav-link" @click="go('install')">Install</a>
        </li>



        <li v-if="is_hub" class="nav-item"  v-bind:class="{ active: tab=='solvency' }">
          <a class="nav-link" @click="go('solvency')">Offchain Demo Explorer</a>
        </li>

        <li class="nav-item"  v-bind:class="{ active: tab=='explorer' }">
          <a class="nav-link" @click="go('explorer')">Explorer</a>
        </li>


        <li class="nav-item" v-bind:class="{ active: tab=='network' }">
          <a class="nav-link" @click="go('network')">Network Stats</a>
        </li>

        <li class="nav-item" v-bind:class="{ active: tab=='help' }">
          <a class="nav-link" @click="go('help')">Help</a>
        </li>


      </ul>

          
  <span>Last block: #{{K.total_blocks}}, {{timeAgo(K.ts)}}</span>
  &nbsp;     

  <div v-if="pubkey">
  <button type="button" class="btn btn-info" @click="call('sync')">Sync</button>
  &nbsp;     
  <button type="button" class="btn btn-danger" @click="call('logout')">Sign Out 
  </button>
    &nbsp; 
  <span v-html="icon(pubkey,32)"></span>
  </div>

    </div>
  </nav>


  <div class="container">
    <div v-if="tab==''" v-html="whitepaper">

    </div>

    <div v-else-if="tab=='help'">
      <h1>Help</h1>

      <p>To start sending and receiving digital assets in Failsafe you need to add hubs and define trust limits.</p>

      <p><b>Hub</b> is an improved version of a bank: Failsafe hubs do not hold your assets unlike banks. They cannot censor you or modify your balance without your explicit permission (your digital signature). Instead, all assets are stored in trust-less payment channels between users and hubs.</p>

      <p><b>Payment channel</b> is an improved version of a traditional bank account. You can always take your latest balance proof to blockchain and get your money back - the hubs cannot steal or freeze your funds. Payment channel works like a cross-signed state-machine - each action must be authorized by the actor and acknowledged by the other party to become final. The hub and the user act as equals and none of them has any privelege over the other.</p>

      <p><img src="/img/channel.png"></p>

      <p><b>Trust limit</b> defines how much <b>uninsured</b> balance you are willing to accept from this hub. E.g. $10,000 means your wallet will not accept payments after uninsured amount reaching 10000</p>

      <p><b>Insurance</b> is how much collateral is stored in blockchain in a payment channel between you and hub. Ideally, your balance must be around insurance amount - this way 100% of your balance is insured plus you're not subject to expensive on-chain fees.</p>

    </div>



    <div v-else-if="tab=='wallet'">

      <template v-if="pubkey">

        <div v-if="is_hub">
          <p>This node is a hub. Total uninsured balances over time:</p>
              <canvas width="100%" id="riskcanvas"></canvas>
        </div>
        <div v-else>

          <p><button class="btn btn-success" @click="call('faucet')">Testnet Faucet</button></p>
            
          <h1 style="display:inline-block">\${{commy(ch.payable)}}</h1>


          <small v-if="ch.payable>0">= {{commy(ch.insurance)}} insurance {{ch.rdelta > 0 ? "+ "+commy(ch.rdelta)+" uninsured" : "- "+commy(-ch.rdelta)+" spent"}}</small> 
          
          <p><div v-if="ch.payable>0 || ch.insurance > 0">

            <div class="progress" style="max-width:1000px">
              <div class="progress-bar" v-bind:style="{ width: Math.round(ch.insured*100/ch.payable)+'%', 'background-color':'#5cb85c'}" role="progressbar">
                {{commy(ch.insured)}} (insured)
              </div>
              <div v-if="ch.rdelta<0" v-bind:style="{ width: Math.round(-ch.rdelta*100/ch.payable)+'%', 'background-color':'#007bff'}"  class="progress-bar" role="progressbar">
                {{commy(ch.rdelta)}} (spent)
              </div>
              <div v-if="ch.rdelta>0" v-bind:style="{ width: Math.round(ch.rdelta*100/ch.payable)+'%', 'background-color':'#dc3545'}"   class="progress-bar"  role="progressbar">
                +{{commy(ch.rdelta)}} (uninsured)
              </div>
            </div>


          </div></p>


          <div class="row">
            <div class="col-sm-6">
              <h3>→ Request</h3>
              <p>Receivable: {{commy(ch.receivable)}}</p>

              <p><div class="input-group" style="width:400px">
                <span class="input-group-addon" id="sizing-addon2">$</span>
                <input type="text" class="form-control " aria-describedby="sizing-addon2" v-model="off_amount" placeholder="Amount">
              </div></p>

              <p><button type="button" class="btn btn-success" @click="call('invoice', {amount: uncommy(off_amount)})">Request Payment</button></p>

              <p><div v-show="new_invoice.length > 0" class="input-group" style="width:400px">
                <input type="text" class="form-control " aria-describedby="sizing-addon2" v-model="new_invoice">
              </div></p>
            </div>

            <div class="col-sm-6">
              <h3>Pay →</h3>
              <p>Payable: {{commy(ch.payable)}}</p>

              <p><div class="input-group" style="width:400px" >
                <input type="text" class="form-control small-input" v-model="pay_invoice" placeholder="Enter Invoice Here" aria-describedby="basic-addon2">
              </div></p>

              <p><button type="button" class="btn btn-success" @click="call('send', unpackInvoice()); pay_invoice='';">Pay Invoice</button></p>

              <div v-if="pay_invoice.length > 0">
                <p>Amount: {{commy(unpackInvoice().amount)}}</p>
                <p>Pay to: <b>{{unpackInvoice().trimmedId}}</b></p>
                <p>Receiver's hub: {{unpackInvoice().hubId}}</p>
              </div>

            </div>
          </div>




          <div class="alert alert-light" role="alert">
          If you want to claim your balance or have any problem with this hub, <a @click="dispute" href="#">you can start a global dispute</a>. You are guaranteed to get <b>insured</b> part of your balance back, and you will get <b>uninsured</b> balance if the hub is still operating and not compromised.
          </div>

          <canvas width="100%" id="riskcanvas"></canvas>

          <table v-if="history.length > 0" class="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th>Amount</th>
                <th>Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in history.slice(0, 50)">
                <td>{{ new Date(h.date).toLocaleString() }}</td>
                <td>{{h.desc}}</td>
                <td>{{commy(h.amount)}}</td>
                <td v-if="h.balance>0">{{commy(h.balance)}}</td>
              </tr>
            </tbody>
          </table>
   

      </div>


      </template>


      <form v-else class="form-signin" v-on:submit.prevent="call('load',{username, pw})">

        <label for="inputUsername" class="sr-only">Username</label>
        <input v-model="username" type="text" id="inputUsername" class="form-control" placeholder="Username" required autofocus>
        <br>

        <p>Make sure your password is unique, strong and you won't forget it, otherwise access to your account is lost. If in doubt, write it down or email it to yourself - <b>password recovery is impossible.</b></p>

        <label for="inputPassword" class="sr-only">Password</label>
        <input v-model="pw" type="password" id="inputPassword" class="form-control" placeholder="Password" required>

        <button class="btn btn-lg btn-primary btn-block" id="login" type="submit">Log In</button>
      </form>

    </div>




    <div v-else-if="tab=='rebalance'">
      <h1>Global Settlement</h1>

      <div class="alert alert-danger" role="alert">
        On this page you can make onchain transactions. Money is deducted from your global balance and deposited to outputs (batch your transactions to save on fees). 
        Global settlement is slow (can take hours) and expensive, but it avoids temporary risks of intermediary hubs.
        <br><br>
        Most likely you don't need to use this feature: go to Wallet page to use instant offchain payments instead.

      </div>

      <p>Global ID: <b>\${{commy(record.id)}}</b></p>
      <p>Global Balance: <b>\${{commy(record.balance)}}</b></p>

      <small>Currently there's only one hub <b>@1</b>. So to deposit to someone's channel with hub use their_ID@1</small>

      <p v-for="out in outs">
        <input style="width:400px" type="text" class="form-control small-input" v-model="out.to" placeholder="ID or ID@hub">
        <input style="width:200px" type="number" class="form-control small-input" v-model="out.amount" placeholder="Amount">
      </p>
   
      <p>
        <button type="button" class="btn btn-success" @click="outs.push({to:'',amount: ''})">Add output</button>
        <button type="button" class="btn btn-warning" @click="rebalance()">Settle Globally</button>
      </p>

    </div>


    <div v-else-if="tab=='network'">

      <h1>Raw K data</h1>

      <pre>{{ JSON.stringify(K, 2, 2) }}</pre>

      <h1>Board of Members</h1>
      <p v-for="m in K.members">{{m.username}} ({{m.location}}) <b v-if="m.hubId">[hub]</b> - <b>{{m.shares}} shares</b></p>


      <h2>Current network settings</h2>
      <p>Blocktime: {{K.blocktime}} seconds</p>
      <p>Blocksize: {{K.blocksize}} bytes</p>
      <p>Account creation fee (pubkey registration): {{commy(K.account_creation_fee)}}</p>

      <p>Average onchain fee: {{commy(K.tax * 83)}} (to short ID) – {{commy(K.tax * 115)}} (to pubkey)</p>

      <h2>Hubs & topology</h2>
      <p>Risk limit: {{commy(K.risk)}}</p>
      <p>Hard risk limit: {{commy(K.hard_limit)}}</p>


      <h2>Snapshots</h2>
      <p>Bytes until next snapshot: {{K.snapshot_after_bytes-K.bytes_since_last_snapshot}}</p>
      <p>Last snapshot at block # : {{K.last_snapshot_height}}</p>


      <h2>Network stats</h2>
      <p>Total blocks: {{K.total_blocks}}</p>
      <p>Of which usable blocks: {{K.total_blocks}}</p>
      <p>Last block received {{timeAgo(K.ts)}}</p>
      
      <p>Network created {{timeAgo(K.created_at)}}</p>

      <p>FSD Market Cap \${{ commy(K.assets[0].total_supply) }}</p>

      <p>Transactions: {{K.total_tx}}</p>
      <p>Tx bytes: {{K.total_tx_bytes}}</p>


      <h2>Governance stats</h2>

      <p>Proposals created: {{K.proposals_created}}</p>



    </div>

    <div v-else-if="tab=='install'">
        <h3>Currently only macOS/Linux are supported</h3>
        <p>1. Install <a href="https://nodejs.org/en/download/">Node.js</a></p>
        <p>2. Copy-paste this snippet to your text editor:</p>
        <pre><code>{{install_snippet}}</code></pre>
        <p>3. (optional) Compare our snippet with snippets from other sources for better security: Failsafe.someshop.com/#install, Failsafe.trustedsite.com...</p>
        <p>4. If there's exact match paste the snippet into <kbd>Terminal.app</kbd></p>
        <p>Or use <a v-bind:href="'/Failsafe-'+K.last_snapshot_height+'.tar.gz'">direct link</a>, run <kbd>./install && node fs 8000</kbd> (to bind to 8000 port)</p>
    </div>

    <div v-else-if="tab=='gov'">
      <h3>Governance</h3>
      <div class="form-group">
        <label for="comment">Description:</label>
        <textarea class="form-control" v-model="proposal[0]" rows="2" id="comment"></textarea>
      </div>

      <div class="form-group">
        <label for="comment">Code to execute (optional):</label>
        <textarea class="form-control" v-model="proposal[1]" rows="2" id="comment"></textarea>
      </div>

      <div class="form-group">
        <label for="comment">Path to .patch (optional):</label>
        <input class="form-control" v-model="proposal[2]" placeholder="after.patch" rows="2" id="comment"></input>
        <small>1. Prepare two directories <b>rm -rf before after && cp -r 1 before && cp -r before after</b>
        <br>2. Edit code in "after", test it, then <b>diff -Naur before after > after.patch</b></small>
      </div>

      <p><button @click="call('propose', proposal)" class="btn btn-warning">Propose</button></p>



      <div v-for="p in proposals">
        <h4>#{{p.id}}: {{p.desc}}</h4>
        <small>Proposed by #{{p.user.id}}</small>

        <pre><code class="javascript hljs" v-html="hljs('javascript',p.code).value"></code></pre>

        <div v-if="p.patch">
          <hr>
          <pre style="line-height:15px; font-size:12px;"><code class="diff hljs"  v-html="hljs('diff',p.patch).value"></code></pre>
        </div>

        <p v-for="u in p.voters">
          <b>{{u.vote.approval ? 'Approved' : 'Denied'}}</b> by #{{u.id}}: {{u.vote.rationale ? u.vote.rationale : '(no rationale)'}}
        </p>

        <small>To be executed at {{p.delayed}} usable block</small>

        <div v-if="record">
          <p v-if="!ivoted(p.voters)">
            <button @click="call('vote', {approve: true, id: p.id})" class="btn btn-success">Approve</button>
            <button @click="call('vote', {approve: false, id: p.id})" class="btn btn-danger">Deny</button>
          </p>

        </div>

      </div>


    </div>



    <div v-else-if="tab=='solvency'">

      <div v-if="is_hub">
        <p>Testnet-only private channels explorer.</p>

        <p>Risk limit: {{commy(K.risk)}}</p>
        <p>Rebalance every {{K.blocktime*2}} seconds.</p>
        <p>Solvency: {{commy(solvency)}}</p>

        <h1>Channel Explorer</h1>
        <table class="table table-striped">
          <thead class="thead-dark">
            <tr>
              <th scope="col">Icon</th>
              <th scope="col">Pubkey</th>

              <th scope="col">Nonces (onchain/offchain)</th>

              <th scope="col">Insurance</th>

              <th scope="col">Settled+Delta</th>

              <th scope="col">Receivable</th>

            </tr>
          </thead>
          <tbody>
          
            <tr v-for="d in deltas">
              <th v-html="icon(toHexString(d.delta_record.userId.data),30)"></th>
              <th scope="row"><small>{{toHexString(d.delta_record.userId.data).substr(0,10)}}...</small></th>

              <td>{{d.nonce}}/{{d.delta_record.nonce}}</td>
              <td>{{commy(d.insurance)}}</td>

              <td v-bind:style="{'background-color': deltaColor(d.rdelta) }">{{commy(d.rdelta)}}</td>

              <td>{{commy(d.receivable)}}</td>

            </tr>

          </tbody>
        </table>
      </div>

    </div>


    <div v-else-if="tab=='explorer'">
      <h1>Blockchain Explorer</h1>
      <table class="table table-striped">
        <thead class="thead-dark">
          <tr>
            <th scope="col">Icon</th>
            <th scope="col">ID</th>
            <th scope="col">Pubkey</th>
            <th scope="col">Global Balance</th>

            <th scope="col">Nonce</th>
            <th scope="col">Insurance</th>
            <th scope="col">Settled</th>
          </tr>
        </thead>
        <tbody>

          <tr v-for="u in users">
            <th v-html="icon(toHexString(u.pubkey.data),30)"></th>

            <th scope="row">{{u.id}}</th>
            <td><small>{{toHexString(u.pubkey.data).substr(0,10)}}..</small></td>
            <td>{{commy(u.balance)}}</td>

            <td>{{u.nonce}}</td>
            
            <td>{{commy(u.hub[0] ? u.hub[0].insurance.insurance : 0)}}</td>
            <td>{{commy(u.hub[0] ? u.hub[0].insurance.rebalanced : 0)}}</td>

          </tr>

        </tbody>
      </table>



    </div>

    <div v-else-if="tab=='names'">
      <h3>Failsafe Names </h3>
      <p>By the end of 2018 you will be able to register a domain name and local DNS resolver will seamlessly load "name.fs" in the browser</p>
    </div>

  </div>
</div>
`
  })
})

/*

<p id="decentText"></p>
<canvas id="decentChart"></canvas>
*/
