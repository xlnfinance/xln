// Single file to store all client side logic
// TODO: break up vue in templates without using preprocessors if possible

l = console.log
ts = () => Math.round(new Date() / 1000)

var pay_invoice = location.hash.split('invoice=')

renderRisk = (hist) => {
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

render = (r) => {
  if (r.alert) notyf.alert(r.alert)
  if (r.confirm) notyf.confirm(r.confirm)

  if (r.already_opened) {
    document.body.innerHTML =
      '<b>The wallet is already opened in another tab. Only one instance of wallet is allowed.</b>'
    return false
  }

  Object.assign(app, r)
  app.$forceUpdate()

  if (r.history && window.riskcanvas) {
    renderRisk(r.history)
  }
}

FS.resolvers.push(render)

FS.onready(() => {
  notyf = new Notyf({delay: 4000})

  var methods = {
    icon: (h, s) => {
      return (
        '<img width=' +
        s +
        ' height=' +
        s +
        ' src="data:image/png;base64,' +
        new Identicon(h.toString(), s).toString() +
        '">'
      )
    },
    hljs: hljs.highlight,

    ivoted: (voters) => {
      return voters.find((v) => v.id == app.record.id)
    },

    toHexString: (byteArray) => {
      return Array.prototype.map
        .call(byteArray, function(byte) {
          return ('0' + (byte & 0xff).toString(16)).slice(-2)
        })
        .join('')
    },

    call: function(method, args) {
      if (method == 'vote') {
        args.rationale = prompt('Why?')
        if (!args.rationale) return false
      }

      FS(method, args).then(render)
      return false
    },
    rebalance: () => {
      var total = app.outs.reduce(
        (k, v) => k + parseFloat(v.amount.length == 0 ? '0' : v.amount),
        0
      )

      //if(confirm("Total outputs: $"+app.commy(total)+". Do you want to broadcast your transaction?")){
      app.call('rebalance', {
        partner: app.ch.partner,
        request_amount: app.uncommy(app.request_amount),
        outs: app.outs
      })
      // }
    },
    derive: (f) => {
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

    dispute_outcome: (ins, parts) => {
      var o = []
      if (parts.insured > 0)
        o.push(`${ins.leftId} gets ${app.commy(parts.insured)}`)
      if (parts.they_insured > 0)
        o.push(`${ins.rightId} gets ${app.commy(parts.they_insured)}`)

      if (parts.promised > 0)
        o.push(
          `${ins.leftId} owes ${app.commy(parts.promised)} to ${ins.rightId}`
        )
      if (parts.they_promised > 0)
        o.push(
          `${ins.rightId} owes ${app.commy(parts.they_promised)} to ${
            ins.leftId
          }`
        )

      return o.join(', ')
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
    uncommy: (str) => {
      if (str.indexOf('.') == -1) str += '.00'

      return parseInt(str.replace(/[^0-9]/g, ''))
    },

    timeAgo: (time) => {
      var units = [
        {name: 'second', limit: 60, in_seconds: 1},
        {name: 'minute', limit: 3600, in_seconds: 60},
        {name: 'hour', limit: 86400, in_seconds: 3600},
        {name: 'day', limit: 604800, in_seconds: 86400},
        {name: 'week', limit: 2629743, in_seconds: 604800},
        {name: 'month', limit: 31556926, in_seconds: 2629743},
        {name: 'year', limit: null, in_seconds: 31556926}
      ]
      var diff = (new Date() - new Date(time * 1000)) / 1000
      if (diff < 5) return 'now'

      var i = 0,
        unit
      while ((unit = units[i++])) {
        if (diff < unit.limit || !unit.limit) {
          var diff = Math.floor(diff / unit.in_seconds)
          return diff + ' ' + unit.name + (diff > 1 ? 's' : '') + ' ago'
        }
      }
    },

    toggle: () => {
      if (localStorage.settings) {
        delete localStorage.settings
      } else {
        localStorage.settings = 1
      }

      app.settings = !app.settings
    },

    ts: () => Math.round(new Date() / 1000),

    trim: (str) => {
      return str ? str.slice(0, 8) + '...' : ''
    }
  }

  var wp = app.innerHTML

  app = new Vue({
    el: '#app',
    mounted: () => {
      FS('load').then(render)

      setInterval(function() {
        FS('load').then(render)
      }, localStorage.auth_code ? 1000 : 30000)
    },
    data() {
      return {
        auth_code: localStorage.auth_code,

        asset: 'FSD',
        peer: 0,

        channels: [],

        whitepaper: wp,

        pubkey: false,
        K: false,
        my_member: false,

        pw: '',
        username: '',

        record: false,

        tab: location.hash.substr(1),

        install_snippet: false,

        request_amount: '',
        outs: [{to: '', amount: '', invoice: ''}],

        off_to: '',
        off_amount: '',

        my_hub: false,

        limits: [100, 1000],

        history_limits: [0, 10],

        blocks: [],
        users: [],

        history: [],
        pending_tx: [],

        proposal: [
          'Increase Blocksize After Client Optimization',
          `K.blocksize += 1000000`,
          ''
        ],

        settings: !localStorage.settings,

        new_invoice: '',
        pay_invoice: location.hash.split('invoice=')[1],
        parsed_invoice: {},

        hardfork: ''
      }
    },
    computed: {
      ch: () => {
        return app.channels[app.peer]
      }
    },
    methods: methods,
    template: `
<div>
  <nav class="navbar navbar-expand-md navbar-light bg-faded mb-4">

    <a class="navbar-brand" href="#">Fairlayer</a>
    <button class="navbar-toggler" type="button" data-toggle="collapse" data-target="#navbarCollapse" aria-controls="navbarCollapse" aria-expanded="false" aria-label="Toggle navigation">
      <span class="navbar-toggler-icon"></span>
    </button>


    <div class="collapse navbar-collapse" id="navbarCollapse">
      <ul class="navbar-nav mr-auto">

        <li class="nav-item" v-bind:class="{ active: tab=='' }">
          <a class="nav-link" @click="go('')">Home</a>
        </li>


        <li v-if="my_member" class="nav-item" v-bind:class="{ active: tab=='install' }">
          <a class="nav-link" @click="go('install')">Install</a>
        </li>


        <li v-if="auth_code" class="nav-item" v-bind:class="{ active: tab=='wallet' }">
          <a class="nav-link" @click="go('wallet')">Wallet</a>
        </li>

      <li class="nav-item dropdown">
        <a class="dropdown-toggle nav-link" data-toggle="dropdown" href="#">Explorers
        <span class="caret"></span></a>
        <ul class="dropdown-menu">
          <li><a class="nav-link" @click="go('blockchain_explorer')" >Blockchain</a></li>
          <li><a class="nav-link" @click="go('account_explorer')" >Accounts</a></li>
          <li><a class="nav-link" @click="go('channel_explorer')" href="#">Channels</a></li>

          <li><a class="nav-link" @click="go('help')" href="#">Network</a></li>


          <li><a class="nav-link" @click="go('gov')" href="#">Governance</a></li>

          <li><a class="nav-link" @click="go('assets')" href="#">Assets</a></li>
          <li><a class="nav-link" @click="go('hubs')" href="#">Hubs</a></li>


        </ul>
      </li>



      </ul>

          
  <span v-if="pending_tx.length > 0">Pending on-chain tx: {{pending_tx.map(t=>t.method).join(', ')}} </span> &nbsp;

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
      <h1>Network</h1>

      <h2>Validators</h2>
      <ul><li v-if="m.website" v-for="m in K.members"><a v-bind:href="m.website+'/#install'">{{m.website}} - by {{m.username}} ({{m.platform}})</a> - <b>{{m.shares}} shares</b></li></ul>

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
      <p>Current onchain db.sqlite hash: {{current_db_hash}}</p>
      <p>Usable blocks: {{K.total_blocks}}</p>
      <p>Last block received {{timeAgo(K.ts)}}</p>
      
      <p>Network created {{timeAgo(K.created_at)}}</p>

      <p>FSD Market Cap {{ commy(K.assets[0].total_supply) }}</p>

      <p>Transactions: {{K.total_tx}}</p>
      <p>Tx bytes: {{K.total_tx_bytes}}</p>


      <h2>Governance stats</h2>

      <p>Proposals created: {{K.proposals_created}}</p>

      <h2>Hard Fork</h2>
      <p><b>Hard fork is like a revolution</b>: sacred and extremely important for long term fairness, even when there is built-in governance protocol. Luckily, everyone is a full node in Failsafe, so you can unilaterally change consensus with a click of a button. If validators vote for things you don't agree with, find like minded people and decide on a new validator set out-of-band. Then paste the code that changes validators below:</p>

      <div class="form-group">
        <label for="comment">Code to execute:</label>
        <textarea class="form-control" v-model="hardfork" rows="4" id="comment"></textarea>
      </div>
      <p><button @click="call('hardfork', {hardfork: hardfork})" class="btn btn-danger">Execute Code</button></p>



    </div>



    <div v-else-if="tab=='wallet'">

      <template v-if="pubkey">

        <h2 class="alert alert-danger" v-if="pending_tx.length>0">Please wait until your <b>{{pending_tx[0].method}}</b> transaction is added to the blockchain.</h2>

        <h2 class="alert alert-danger" v-if="K.ts < ts() - 600">Please wait until your node is fully synced. <br>Last known block: {{timeAgo(K.ts)}}</h2>

        <h2 class="alert alert-danger" v-if="my_hub">This node is a hub @{{my_hub.handle}}</h2>
        <br>


        <div v-if="record">
          <h2>Balance on-chain: <b>{{commy(record.balance)}}</b></h2>
          <p>The most secure kind of balance, but expensive to use because requires global broadcast. This balance is not stored with a hub. It is also used to cover on-chain transaction fees. Your on-chain ID: <b>{{record.id}}</b></p>

          <hr />
        </div>

        <template v-if="channels.length > 0" v-for="(ch, index) in channels">
          <h2 style="display:inline-block">Balance @{{ch.hub.handle}}: {{commy(ch.payable)}}</h2>

          <small v-if="ch.payable>0">
          = {{commy(ch.insurance)}} insurance 
          {{ch.they_promised > 0 ? "+ "+commy(ch.they_promised)+" uninsured" : ''}}
          {{ch.they_insured > 0 ? "- "+commy(ch.they_insured)+" spent" : ''}}
          {{ch.d.they_hard_limit > 0 ? "+ "+commy(ch.d.they_hard_limit)+" uninsured limit" : ''}}
          </small> 
          
          <p><div v-if="false && ch.bar > 0">
            <div class="progress" style="max-width:1400px">
              <div v-bind:style="{ width: Math.round(ch.promised*100/ch.bar)+'%', 'background-color':'#0000FF'}"   class="progress-bar"  role="progressbar">
                -{{commy(ch.promised)}} (we promised)
              </div>
              <div class="progress-bar" v-bind:style="{ width: Math.round(ch.insured*100/ch.bar)+'%', 'background-color':'#5cb85c'}" role="progressbar">
                {{commy(ch.insured)}} (insured)
              </div>
              <div v-bind:style="{ width: Math.round(ch.they_insured*100/ch.bar)+'%', 'background-color':'#007bff'}"  class="progress-bar" role="progressbar">
                -{{commy(ch.they_insured)}} (spent)
              </div>
              <div v-bind:style="{ width: Math.round(ch.they_promised*100/ch.bar)+'%', 'background-color':'#dc3545'}"   class="progress-bar"  role="progressbar">
                +{{commy(ch.they_promised)}} (uninsured)
              </div>
            </div>
          </div></p> 

          <p>Tech data: status {{ch.d.status}} nonce {{ch.d.nonce}} pending {{trim(ch.d.pending)}}</p>

        </template>




        <div class="row">
          <div class="col-sm-6">
            <p><div class="input-group" style="width:400px">
              <span class="input-group-addon" id="sizing-addon2">{{asset}}</span>
              <input type="text" class="form-control" aria-describedby="sizing-addon2" v-model="off_amount" placeholder="Amount">
            </div></p>


            <p><button type="button" class="btn btn-success" @click="call('invoice', {asset: asset, amount: uncommy(off_amount)})">→ Request Money</button></p>

            <p v-for="(value, k) in invoices" style="word-wrap: break-word">Invoice for {{commy(value.amount)}} ({{value.status}}):<br> {{value.invoice}}</p>


          </div>

          <div class="col-sm-6">
            <p><div class="input-group" style="width:400px" >
              <input type="text" class="form-control small-input" v-model="pay_invoice" @input="call('send', {dry_run: true, pay_invoice: pay_invoice})"  placeholder="Enter Invoice Here" aria-describedby="basic-addon2">
            </div></p>


            <p><button type="button" class="btn btn-success" @click="call('send', {pay_invoice: pay_invoice})">Send Money → </button></p>

            <p v-for="(value, k) in purchases">Payment sent for invoice: {{k}}</p>

            <div v-if="parsed_invoice && parsed_invoice.amount">
              <p>Amount: {{commy(parsed_invoice.amount)}}</p>
              <p>Fee: {{commy(parsed_invoice.fee)}}</p>
              <p>Invoice: {{trim(parsed_invoice.invoice)}}</p>
              <p>Destination: {{trim(parsed_invoice.pubkey)}}</p>
              <p>Receiving hubs: <b>{{parsed_invoice.partners.join(', ')}}</b></p>
            </div>

          </div>
        </div>






<nav>
  <div class="nav nav-tabs" id="nav-tab" role="tablist">
    <a class="nav-item nav-link" id="nav-history-tab" data-toggle="tab" href="#nav-history" role="tab" aria-controls="nav-history" aria-selected="true">History</a>

    <a v-if="ch" class="nav-item nav-link" id="nav-uninsured-tab" data-toggle="tab" href="#nav-uninsured" role="tab" aria-controls="nav-uninsured" aria-selected="false">Uninsured Limits</a>

    <a class="nav-item nav-link" id="nav-onchain-tab" data-toggle="tab" href="#nav-onchain" role="tab" aria-controls="nav-onchain" aria-selected="false">On-Chain</a>

    <a class="nav-item nav-link active" id="nav-testnet-tab" data-toggle="tab" href="#nav-testnet" role="tab" aria-controls="nav-testnet" aria-selected="false">Testnet</a>

  </div>
</nav>

<div class="tab-content mt-3" id="nav-tabContent">
  <div class="tab-pane fade" id="nav-history" role="tabpanel" aria-labelledby="nav-history-tab">

        <table v-if="payments.length > 0" class="table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Type</th>
              <th>Amount</th>
              <th>Destination</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="h in payments.slice(history_limits[0], history_limits[1])">
              <td>{{h.status}}</td>
              <td>{{h.is_inward ? 'Inward' : 'Outward'}}</td>
              <td>{{commy(h.is_inward ? h.amount : -h.amount)}}</td>
              <td>{{trim(h.destination)}}</td>
              <td>{{ new Date(h.createdAt).toLocaleString() }}</td>
            </tr>

            <p><a @click="history_limits[1]=1000">Show All</a></p>
          </tbody>
        </table>
        <p v-else>There is no transaction history so far. Go to an exchange or use Testnet faucet to receive money.</p>
  </div>


  <div v-if="ch" class="tab-pane fade" id="nav-uninsured" role="tabpanel" aria-labelledby="nav-uninsured-tab" >
      <h3>Uninsured Limits</h3>

        <select v-model="peer" class="custom-select custom-select-lg mb-3">
          <option disabled>Select current hub</option>
          <option v-for="(a,index) in channels" :value="index">{{a.hub.handle}}</option>
        </select>


      <p>You can pay through the hub if you deposit insurance to this channel, but <b>in order to receive</b> from the hub you must define <b>uninsured limits</b> below. </p>

      <p><label>Soft limit (currently {{commy(ch.d.soft_limit)}}, recommended {{commy(K.risk)}}) tells the hub after what amount uninsured balances must be insured. Low soft limit makes the hub rebalance more often thus incurs higher rebalance fees.</label>
      <input v-once type="text" class="form-control col-lg-4" v-model="limits[0]">
      </p>

      <p>
      <label>Hard limit (currently {{commy(ch.d.hard_limit)}}, recommended 1000) defines a maximum uninsured balance you can have at any time. Low hard limit may prevent you from receiving large payments.</label>
      <input v-once type="text" class="form-control col-lg-4" v-model="limits[1]"></p>

      <p><button type="button" class="btn btn-danger" @click="call('setLimits', {limits: limits, partner: ch.partner})" href="#">Save Uninsured Limits</button></p>

      <p>Wondering how much risk you are exposed to? This chart shows your uninsured balances over time and can help you to structure (stream) payments to reduce your risk to negligible amount.</p>

      <canvas width="100%" style="max-height: 200px" id="riskcanvas"></canvas>
  </div>



  <div class="tab-pane fade" id="nav-onchain" role="tabpanel" aria-labelledby="nav-onchain-tab">
    <div v-if="record && ch">
      <h3>On-chain Actions</h3>

      <small v-if="ch.insured>0">Amount to withdraw (up to <b>{{commy(ch.insured)}}</b>) from <b>insured</b> balance to your on-chain balance.</small>

      <p v-if="ch.insured>0"><input style="width:300px" type="text" class="form-control small-input" v-model="request_amount" placeholder="Amount to Withdraw"></p>
     
      <small>Deposits to other users or channels.</small>

      <p v-for="out in outs">
        <input style="width:300px" type="number" class="form-control small-input" v-model="out.amount" placeholder="Amount to Send">

        <input style="width:300px" type="text" class="form-control small-input" v-model="out.to" placeholder="ID or ID@hub">

        <input style="width:300px" type="text" class="form-control small-input" v-model="out.invoice" placeholder="Invoice (optional)">
      </p>
      <p>
      <button type="button" class="btn btn-success" @click="outs.push({to:'',amount: '', invoice:''})">Add Deposit</button>
      </p>

      <p>
        <button type="button" class="btn btn-warning" @click="rebalance()">Rebalance On-Chain</button>
      </p>

      <p>If the hub becomes unresponsive, doesn't honor your soft limit and insure your balances, fails to process your payments or anything else: you can always start a dispute on-chain. You are guaranteed to get {{commy(ch.insured)}} (<b>insured</b> part of your balance), but you may lose up to {{commy(ch.they_promised)}} (<b>uninsured</b> balance) if the hub is completely compromised.
      </p>

      <p>After a timeout money will arrive to your on-chain balance, then you will be able to move it to another hub.</p>

      <p v-if="ch.d.status == 'disputed'"> 
        Please wait for dispute resolution. <span v-if="ch.ins.dispute_delayed > 0">Will be resolved at block {{ch.ins.dispute_delayed}}</span>

      </p>
      <p v-else-if="record && record.balance >= K.standalone_balance"> 
        <button class="btn btn-danger" @click="call('dispute', {partner: ch.partner})" href="#">Start Dispute</button>
      </p>
      <p v-else>To start on-chain dispute you must be registred on-chain and have on your on-chain balance at least {{commy(K.standalone_balance)}} to cover transaction fees. Please ask another hub or user to register you and/or deposit money to your on-chain balance.</p>

    </div>
    <div v-else>
      <h3>Registration</h3>
      <p>You are not currently registered on the blockchain. On-chain registration is not required but it allows you to insure your balances, start disputes with hubs and do rebalances yourself. Your account will be registered automatically once you have more money in uninsured balances. </p>
      <p>Otherwise you can ask someone to rebalance on-chain at least $10 to your temporary ID: <br>
      <b>{{pubkey}}</b></p>

    </div>
  </div>


  <div class="tab-pane fade show active" id="nav-testnet" role="tabpanel" aria-labelledby="nav-testnet-tab">
        
        <h3>Testnet Actions</h3>
        <p>On this page we will guide you through basic functionality and user stories, telling what happens under the hood.</p>

        <p>Case 1. Just arrived? You can go to an exchange or any other service to purchase our digital assets. For now just click on faucet. After reaching {{commy(K.risk)}} in uninsured balance, the hub must rebalance/insure you on-chain - <b>wait for it</b>. That will automatically register your account on-chain. <b>Keep an eye on Blockchain Explorer - every node will see this rebalance transaction</b></p>
        <p><button class="btn btn-success mb-3" @click="call('testnet', { partner: ch.partner, action: 1 })">Testnet Faucet</button></p>

        <p>Case 2. Now let's practice p2p payments: use the install snippet again but replace id=fs to id=fs2 and 8001 port to 8002 (to run a parallel user on the same machine). Under the new user, create an invoice for 123 and pay it with our user. Instantly you will see this user has 123 under "spent" and a new user under "uninsured". After some time the hub will ask your node to withdraw from your channel in order to insure the second user, because 123 is beyond risk limit. If you'd pay $5, there would be no rebalance.</p>

        <p>Case 3. You both were using @eu hub, now let's practice 2 hops payment: <b>you->eu->jp->new user</b>. Select jp hub by another user, create an invoice and pay it with our user again. You will pay fees to both hubs (roughly 0.1+0.1%).</p>

        <p>Case 4. Request withdraw by this user on On-chain rebalance page. Withdraw is taking money "the nice way" from your hub and you could move them to another hub or to make a direct payment to someone else's channel on-chain.</p>

        <p>Case 5. If the hub tries to censor you and didn't let to withdraw the nice way, you can do the ugly way: start on-chain dispute under On-Chain Dispute tab. (Notice that after a dispute uninsured limits are reset to 0 i.e. you reset your trust to the hub)</p>

        <p>Case 6. More than that, you can try to cheat on the hub with the button below: it will broadcase the most profitable state - biggest balance you ever owned. When hub notices that, they will post latest state before delay period. Keep an eye on Blockchain Explorer page to see that.</p>

        <button class="btn btn-success mb-3" @click="call('dispute', {partner: ch.partner, profitable: true})" href="#">Cheat in Dispute</button><br>

        <p>Case 7. If you've been offline for too long, and the hub tried to get a withdrawal from you, they would have to dispute the channel with you.</p>

        <button class="btn btn-success mb-3" @click="call('testnet', { partner: ch.partner, action: 2 })">Ask Hub to Start Dispute</button><br>

        <p>Case 8. Using this button you can ensure you're safe if the hub also tries to cheat on you with most profitable state.</p>

        <button class="btn btn-success mb-3" @click="call('testnet', { partner: ch.partner, action: 3 })">Ask Hub to Cheat in Dispute</button>
  </div>
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







    <div v-else-if="tab=='install'">
        <h3>Decentralized Install for macOS/Linux/Windows</h3>
        <p>For greatly increased security our install process is a little bit longer than just downloading an executable file. First, you'd need <a href="https://nodejs.org/en/download/">Node.js installed</a> (9.6.0+). For macOS/Linux: copy-paste this self-contained snippet to your text editor:</p>
        <pre><code>{{install_snippet}}</code></pre>
        <p>Double check it visually with other validators (whichever looks trustworthy to you) listed below to ensure our server isn't compromised. If there's exact match paste the snippet into your Terminal.app</p>

        <ul><li v-if="m.website" v-for="m in K.members"><a v-bind:href="m.website+'/#install'">{{m.website}} - by {{m.username}} ({{m.platform}})</a></li></ul>

        <p>On Windows? <a v-bind:href="'/Failsafe-'+K.last_snapshot_height+'.tar.gz'">Download snapshot directly</a>, verify the hash with <kbd>certUtil -hashfile Failsafe-{{K.last_snapshot_height}}.tar.gz SHA256</kbd> then run <kbd>./install && node fs -p8001</kbd> (8001 is default port). You might need WinRAR/7-Zip to unpack tar.gz archive.</p>

        <p>Looking for genesis state for research or analytics? <a href="/Failsafe-1.tar.gz">Get Failsafe-1.tar.gz here</a></p>
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

      <p v-if="my_member"><button @click="call('propose', proposal)" class="btn btn-warning">Propose</button></p>
      <p v-else>Currently only stakeholders can submit a new amendment.</p>


      <div v-for="p in proposals">
        <h4>#{{p.id}}: {{p.desc}}</h4>
        <small>Proposed by #{{p.user.id}}</small>
        <div v-html="icon(toHexString(p.user.pubkey.data),30)"></div>

        <pre><code class="javascript hljs" v-html="hljs('javascript',p.code).value"></code></pre>

        <div v-if="p.patch">
          <hr>
          <pre style="line-height:15px; font-size:12px;"><code class="diff hljs"  v-html="hljs('diff',p.patch).value"></code></pre>
        </div>

        <p v-for="u in p.voters">
          <div v-html="icon(toHexString(u.pubkey.data),30)"></div>
          <b>{{u.vote.approval ? 'Approved' : 'Denied'}}</b> by #{{u.id}}: {{u.vote.rationale ? u.vote.rationale : '(no rationale)'}}
        </p>

        <small>To be executed at {{p.delayed}} usable block</small>

        <div v-if="record">
          <p v-if="!ivoted(p.voters)">
            <button @click="call('vote', {approval: 1, id: p.id})" class="btn btn-success">Approve</button>
            <button @click="call('vote', {approval: 0, id: p.id})" class="btn btn-danger">Deny</button>
          </p>

        </div>
      </div>
    </div>










    <div v-else-if="tab=='blockchain_explorer'">
      <h1>Blockchain Explorer</h1>

      <p>Blockchain is a chain of blocks, which contain transactions. These transactions were publicly broadcasted and executed on every full node, including yours. On this page you will see only last few blocks that your node processed, after a while they are deleted from your machine - you aren't required to store them.</p> 

      <p>Empty blocks are omitted. Under each block you will see what happened: transactions submitted by users and some automatic events.</p>

      <p>If you want to review historical blocks from the beginning go to an explorer of any of the validators listed under Network.</p>

      <table class="table">
        <thead class="thead-dark">
          <tr>
            <th scope="col">#</th>
            <th scope="col">Prev Hash</th>
            <th scope="col">Hash</th>
            <th scope="col">Relayed By</th>
            <th scope="col">Relayed At</th>
            <th scope="col">Total Tx</th>
            <th scope="col">Inputs / Outputs Volume</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="b in blocks">
            <tr>
              <td>{{b.id}}</td>
              <td>{{b.prev_hash.substr(0,10)}}</td>
              <td>{{b.hash.substr(0,10)}}</td>
              <td>{{b.built_by}}</td>
              <td>{{timeAgo(b.timestamp)}}</td>
              <td>{{b.total_tx}}</td>
              <td>{{commy(b.meta.inputs_volume)}} / {{commy(b.meta.outputs_volume)}}</td>
            </tr>
      
            <tr v-for="m in b.meta.parsed_tx">

              <td colspan="7">
                <span class="badge badge-warning">{{m.method}} by {{m.signer.id}} ({{commy(m.tax)}} fee, size {{m.length}}):</span>&nbsp;

                <template v-if="m.method=='rebalance'">
                  <template v-for="d in m.disputes">
                    <span class="badge badge-primary">{{d[1] == 'started' ? "started a dispute with "+d[0] : "won a dispute with "+d[0] }}: {{dispute_outcome(d[2], d[3])}}
                    </span>&nbsp;
                  </template>

                  <template v-for="d in m.inputs">
                    <span class="badge badge-danger">{{commy(d[0])}} from {{d[1]}}</span>&nbsp;
                  </template>

                  <template v-for="d in m.debts">
                    <span class="badge badge-dark">{{commy(d[0])}} debt to {{d[1]}}</span>&nbsp;
                  </template>

                  <template v-for="d in m.outputs">
                    <span class="badge badge-success" >{{commy(d[0])}} to {{d[2] ? (d[1] == m.signer.id ? '': d[1])+'@'+d[2] : d[1]}}{{d[3] ? ' for '+d[3] : ''}}</span>&nbsp;
                  </template>
                </template>

              </td>
            </tr>

            <tr v-if="b.meta.cron.length > 0">
              <td colspan="7">
                <template v-for="m in b.meta.cron">
                  <span v-if="m[0] == 'autodispute'" class="badge badge-primary">Dispute auto-resolved: {{dispute_outcome(m[1], m[2])}}</span>
                  <span v-else-if="m[0] == 'snapshot'" class="badge badge-primary">Generated a new snapshot at #{{m[1]}}</span>
                  <span v-else-if="m[0] == 'executed'" class="badge badge-primary">Proposal {{m[1]}} gained majority vote and was executed</span>
                  &nbsp;
                </template>
              </td>
            </tr>


          </template>

        </tbody>
      </table>
    </div>
    <div v-else-if="tab=='account_explorer'">
      <h1>Account Explorer</h1>
      <p>This is a table of registered users in the network. On-chain balance is normally used to pay transaction fees, and most assets are stored in payment channels under Channel Explorer.</p>

      <table class="table table-striped">
        <thead class="thead-dark">
          <tr>
            <th scope="col">Icon</th>
            <th scope="col">ID</th>
            <th scope="col">Pubkey</th>
            <th scope="col">On-chain Balance</th>
            <th scope="col">Nonce</th>
            <th scope="col">Debts</th>
          </tr>
        </thead>
        <tbody>

          <tr v-for="u in users">
            <th v-html="icon(toHexString(u.pubkey.data),30)"></th>

            <th scope="row">{{u.id}}</th>
            <td><small>{{toHexString(u.pubkey.data).substr(0,10)}}..</small></td>
            <td>{{commy(u.balance)}}</td>
            <td>{{u.nonce}}</td>
            <td>{{u.debts.length}}</td>
          </tr>

        </tbody>
      </table>
    </div>
    <div v-else-if="tab=='channel_explorer'">
      <h1>Channel Explorer</h1>
      <p>Payment channels represent collateral between two parties: normally at least one of them is a hub. If the user has 100 units in insurance with @hub, it means the user is guaranteed to get up to 100 units back even if the hub is completely compromised. Pubkeys of both accounts are sorted numerically, lower one is called "left" another one is "right".</p>

      <table class="table table-striped">
        <thead class="thead-dark">
          <tr>
            <th scope="col">Left ID</th>
            <th scope="col">Right ID</th>
            <th scope="col">Insurance</th>
            <th scope="col">Ondelta</th>
            <th scope="col">Withdrawal Nonce</th>
            <th scope="col">Dispute</th>
          </tr>
        </thead>
        <tbody>

          <tr v-for="u in insurances">
            <th>{{u.leftId}}</th>
            <th>{{u.rightId}}</th>
            <th>{{commy(u.insurance)}}</th>
            <th>{{commy(u.ondelta)}}</th>
            <th>{{u.nonce}}</th>
            <th>{{u.dispute_delayed ? "Until "+u.dispute_delayed+" started by "+(u.dispute_left ? u.leftId : u.rightId) : "N/A" }}</th>
          </tr>

        </tbody>
      </table>

    </div>



  </div>
</div>
`
  })
})

// delayed features:

/*



<div class="float-right"><select v-model="asset" class="custom-select custom-select-lg mb-3">
  <option disabled>Select current asset</option>
  <option v-for="(a,index) in K.assets" :value="a.ticker">{{a.name}}</option>
</select></div>
*/
