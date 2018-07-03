<script>
import UserIcon from './UserIcon'
import Highlight from './Highlight'
import Home from './Home'

export default {
  components: {
    UserIcon,
    Highlight,
    Home
  },
  mounted() {
    window.app = this

    window.onscroll = function(ev) {
      if (window.innerHeight + window.scrollY >= document.body.offsetHeight) {
        app.history_limit += 20
      }
    }

    app.call('load')

    app.go(location.hash.substr(1).split(/\/|\?/)[0])

    if (localStorage.auth_code) {
      this.interval = setInterval(function() {
        app.call('load')
      }, 20000)
    }

    setInterval(()=>app.$forceUpdate(), 1000)
  },
  destroyed() {
    clearInterval(this.interval)
  },
  data() {
    return {
      auth_code: localStorage.auth_code,

      asset: hashargs['asset'] ? parseInt(hashargs['asset']) : 1,
      partner: 1,
      assets: [],
      orders: [],
      channels: [],
      faucet_amount: '',

      new_asset: {
        name: 'Yen ¥',
        ticker: 'YEN',
        amount: 100000000000,
        desc:
          'This asset represents Japanese Yen and is backed by the Bank of Japan.'
      },
      new_hub: {},

      pubkey: false,
      K: false,
      my_member: false,

      pw: '',
      username: '',

      record: false,

      tab: '',

      install_snippet: false,

      request_amount: '',
      outs: [
        {
          to: '',
          amount: '',
          invoice: ''
        }
      ],

      off_to: '',
      off_amount: '',

      my_hub: false,

      limits: [100, 1000],
      metrics: {},

      history_limit: 10,

      blocks: [],
      users: [],

      history: [],
      pending_batch: null,

      proposal: [
        'Increase Blocksize After Client Optimization',
        `K.blocksize += 1000000;`,
        ''
      ],

      proposals: [],
      set_name: '',

      settings: !localStorage.settings,

      outward_address: hashargs['address'],
      outward_amount: hashargs['amount'],
      outward_invoice: hashargs['invoice'],
      // which fields can be changed? all, amount, none
      outward_editable: hashargs['editable'] ? hashargs['editable'] : 'all',

      
      addrisk: false,
      lazy: false,

      order: {
        amount: '',
        rate: '',
        buyAssetId: 2
      },

      hardfork: '',

      // useful for visual debugging
      dev_mode: false
    }
  },
  watch: {
    record(val) {
      let title = 'Fair'
      if (val && val.username) {
        title = `Fair: ${val.username}`
      }
      document.title = title
    }
  },
  computed: {
    ch: () => {
      // find current channel for selected asset and hub
      return app.channels
        ? app.channels.find(
            (c) => c.partner == app.partner && c.d.asset == app.asset
          )
        : false
    }
  },
  methods: {
    stream: () => {
      var n = 0
      var pay = () => {
        document.querySelector('.btn-success').click()
        if (n++ < 100) setTimeout(pay, 100)
      }
      pay()
    },

    ivoted: (voters) => {
      return voters.find((v) => v.id == app.record.id)
    },

    skipDate: (h, index) => {
      // if previous timestamp has same date, don't show it
      var str = new Date(h.createdAt).toLocaleString()
      if (index == 0) app.skip_prev_date = false

      if (app.skip_prev_date && str.startsWith(app.skip_prev_date)) {
        app.skip_prev_date = str.split(', ')[0]
        return str.split(', ')[1]
      } else {
        app.skip_prev_date = str.split(', ')[0]
        return str.split(', ')[1] + ', <b>'+str.split(', ')[0]+'</b>'
      }
    },
    
    assetPayments: (asset) => {
      return app.payments.filter(p=>p.asset == asset)
    },

    toHexString: (byteArray) => {
      return Array.prototype.map
        .call(byteArray, function(byte) {
          return ('0' + (byte & 0xff).toString(16)).slice(-2)
        })
        .join('')
    },

    call: function(method, args = {}) {
      if (method == 'vote') {
        args.rationale = prompt('Why?')
        if (!args.rationale) return false
      }

      if (app) {
        // share automatically scoped asset we work with now
        args.asset = app.asset
      }

      FS(method, args).then(render)
      return false
    },
    onchain: () => {
      var total = app.outs.reduce(
        (k, v) => k + parseFloat(v.amount.length == 0 ? '0' : v.amount),
        0
      )

      //if(confirm("Total outputs:$"+app.commy(total)+". Do you want to broadcast your transaction?")){
      var obj = {
        outs: app.outs,
        asset: app.asset
      }
      // any withdrawal?
      if (app.ch && app.ch.insured > 0) {
        obj.partner = app.ch.partner
        obj.request_amount = app.uncommy(app.request_amount)
      }



      app.call('rebalance', obj)
      // }
    },
    estimate: (f) => {
      if (f) {
        app.order.rate = (app.asset > app.order.buyAssetId
          ? app.order.buyAmount / app.order.amount
          : app.order.amount / app.order.buyAmount
        ).toFixed(6)
      } else {
        app.order.buyAmount = (app.asset > app.order.buyAssetId
          ? app.order.amount * app.order.rate
          : app.order.amount / app.order.rate
        ).toFixed(6)
      }
    },
    derive: (f) => {
      var data = {
        username: inputUsername.value,
        password: inputPassword.value
      }

      app.call('load', data)
      return false
    },

    buyAmount: (d) => {
      return (
        (d.assetId > d.buyAssetId ? d.amount * d.rate : d.amount / d.rate) / 100
      )
    },
    to_ticker: (assetId) => {
      let asset = app.assets ? app.assets.find((a) => a.id == assetId) : null

      return asset ? asset.ticker : 'N/A'
    },

    getAsset: (asset, user) => {
      if (!user) user = app.record
      if (!user) return 0

      if (user['balance'+asset]) {
        return user['balance'+asset]
      } else {
        if (user.balances) {
          var bal = JSON.parse(user.balances)[asset]
          return bal ? bal : 0
        } else {
          return 0
        }
      }
    },

    parse_balances: (balances) => {
      if (balances) {
        return Object.entries(JSON.parse(balances))
          .map((kv) => app.to_ticker(kv[0]) + ': ' + app.commy(kv[1]))
          .join(', ')
      } else {
        return ''
      }
    },

    go: (path) => {
      var authed = ['wallet', 'credit', 'onchain', 'testnet']

      if (authed.includes(path) && !localStorage.auth_code) path = ''

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

    dispute_outcome: (prefix, ins, parts) => {
      let c = app.commy
      let o = ''

      var sep = ' | '

      if (parts.uninsured > 0) {
        o += `${c(parts.insured)} + ${c(parts.uninsured)}${sep}`
      } else if (parts.they_uninsured > 0) {
        o += `${sep}${c(parts.they_insured)} + ${c(parts.they_uninsured)}`
      } else {
        o += `${parts.insured > 0 ? c(parts.insured) : ''}${sep}${parts.they_insured > 0 ? c(parts.they_insured) : ''}`
      }
      return `${prefix} (${ins.leftId}) ${o} (${ins.rightId})`
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
      //if (str.indexOf('.') == -1) str += '.00'

      return Math.round(parseFloat(str) * 100) //parseInt(str.replace(/[^0-9]/g, ''))
    },

    timeAgo: (time) => {
      var units = [
        {
          name: 'second',
          limit: 60,
          in_seconds: 1
        },
        {
          name: 'minute',
          limit: 3600,
          in_seconds: 60
        },
        {
          name: 'hour',
          limit: 86400,
          in_seconds: 3600
        },
        {
          name: 'day',
          limit: 604800,
          in_seconds: 86400
        },
        {
          name: 'week',
          limit: 2629743,
          in_seconds: 604800
        },
        {
          name: 'month',
          limit: 31556926,
          in_seconds: 2629743
        },
        {
          name: 'year',
          limit: null,
          in_seconds: 31556926
        }
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
    },
    payment_status: (t) => {
      var s = ''
      if (t.type == 'del' || t.type == 'delrisk') {
        s = t.secret ? '✔' : '❌'
      }
      if (t.type == 'add' || t.type == 'addrisk') {
        s = '🔒'
      }
      // new and sent are considered "pending" statuses
      return s + (['ack', 'processed'].includes(t.status) ? '' : '🕟')
    }
  }
}
</script>
<template>
  
  <div>
<div style="background-color: #FFFDDE; border:thin solid #EDDD00">
  <p style='margin: 10px;text-align:center'>This testnet is restarted once every few days. Mainnet: August 24, 2018.</p> 
</div>


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
          <li v-if="my_member"  class="nav-item" v-bind:class="{ active: tab=='install' }">
            <a class="nav-link" @click="go('install')">⬇ Install</a>
          </li>
          <li v-if="auth_code" class="nav-item" v-bind:class="{ active: tab=='wallet' }">
            <a class="nav-link" @click="go('wallet')">💰 Wallet</a>
          </li>
          <li v-if="pubkey" class="nav-item" v-bind:class="{ active: tab=='credit' }">
            <a class="nav-link" @click="go('credit')">💳 Credit Limits</a>
          </li>
          <li v-if="pubkey" class="nav-item" v-bind:class="{ active: tab=='onchain' }">
            <a class="nav-link" @click="go('onchain')">🌐 Onchain</a>
          </li>
          <li class="nav-item" v-bind:class="{ active: tab=='exchange' }">
            <a class="nav-link" @click="go('exchange')">⇄ Exchange</a>
          </li>

          

          <li v-if="pubkey && dev_mode" class="nav-item" v-bind:class="{ active: tab=='testnet' }">
            <a class="nav-link" @click="go('testnet')">Testnet</a>
          </li>


          <li class="nav-item dropdown">
            <a class="dropdown-toggle nav-link" data-toggle="dropdown" href="#" title="Insights, exploration and analytics of the network at your fingertips">🔍 Explorers
        <span class="caret"></span></a>
            <ul class="dropdown-menu">
              <li><a class="nav-link" @click="go('blockchain_explorer')" title="Learn about latest blocks and tx">📖 Blockchain</a></li>

              <li><a class="nav-link" @click="go('validators')">🤵 Validators</a></li>

              <li><a class="nav-link" @click="go('assets')" title="Currently registred assets in the system. Create your own!">💱 Assets</a></li>
              <li><a class="nav-link" @click="go('hubs')" title="Hubs that instantly process payments. Run your own!">⚡️ Hubs</a></li>


              <li><a class="nav-link" @click="go('account_explorer')" title="Registred accounts in the system">👨‍💼 Accounts</a></li>
              <li><a class="nav-link" @click="go('channel_explorer')" title="Inspect insurances between different users and hubs">💸 Insurances</a></li>
              <li><a class="nav-link" @click="go('help')" title="Various info about the network and stats">📡 Network</a></li>
              <li><a class="nav-link" @click="go('gov')" title="Latest offered proposals and voting process">💡 Governance</a></li>
              <li><a class="nav-link" @click="go('hashlocks')">🔐 Hashlocks</a></li>

              <li><a class="nav-link" @click="go('metrics')" title="Various productivity metrics of current node">🎛 Node Metrics</a></li>
            </ul>
          </li>

          <li class="nav-item">
            <a class="nav-link" href="https://github.com/fairlayer/fair/blob/master/wiki/start.md">📒 Docs</a>
          </li>

          <li class="nav-item">
            <a class="nav-link" href="https://demo.fairlayer.com">🏄‍♂️ User Experience Demo</a>
          </li>


        </ul>
        <span class="badge badge-danger" v-if="pending_batch">Pending tx</span> &nbsp;
        <span @click="call('sync')" v-bind:class='["badge", K.ts > ts() - K.safe_sync_delay ? "badge-light" : "badge-danger"]'>Block #{{K.total_blocks}}, {{timeAgo(K.ts)}}</span> &nbsp;
        <div v-if="pubkey">
          <span class="pull-left"><select v-model="asset" class="custom-select custom-select-lg mb-6" @change="order.buyAssetId = (asset==1 ? 2 : 1)">
            <option disabled>Select current asset</option>
            <option v-for="(a,index) in assets" :value="a.id">{{a.name}} ({{a.ticker}})</option>
          </select></span>

          <button type="button" class="btn btn-danger" @click="call('logout')">Sign Out
          </button>
          &nbsp;
          <span @click="dev_mode=!dev_mode" :title="record && record.id">
            <UserIcon :hash="pubkey" :size="32"></UserIcon>
          </span>
        </div>
        
      </div>
    </nav>
    <div class="container">
      <div title="Tps in last 5 minutes" class="tpstrend visible-lg-4" @click="go('metrics')" v-if="my_hub">
        <trend
          :data="metrics.settle.avgs.slice(metrics.settle.avgs.length-300)"
          :gradient="['#6fa8dc', '#42b983', '#2c3e50']"
          auto-draw
          :min=0
          :width=150
          :height=50>
        </trend>
      </div>

      <div v-if="tab==''">
        <Home></Home>
      </div>
      <div v-else-if="tab=='metrics'">
        <h2>Node Metrics</h2>

        <p v-for="(obj, index) in metrics">
          <b v-if="['settle','fail'].indexOf(index) == -1">Average {{index}}/s: {{commy(obj.last_avg)}} (max {{commy(obj.max)}}, total {{commy(obj.total)}}).</b>
          <b v-else>Average {{index}}/s: {{obj.last_avg}} (max {{obj.max}}, total {{obj.total}}).</b>

          <trend
            :data="obj.avgs.slice(obj.avgs.length-300)"
            :gradient="['#6fa8dc', '#42b983', '#2c3e50']"
            auto-draw
            :min="0"
            smooth>
          </trend>
        </p>


      </div>
      <div v-else-if="tab=='validators'">
        <h1>Validators</h1>
        <ul>
          <li v-if="m.website" v-for="m in K.members"><a v-bind:href="m.website+'/#install'">{{m.website}} - by {{m.username}} ({{m.platform}})</a> - <b>{{m.shares}} shares</b></li>
        </ul>
      </div>
      <div v-else-if="tab=='help'">
        <h1>Network</h1>


        <h2>General settings</h2>
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
        <p>Current onchain db.sqlite hash: {{K.current_db_hash}}</p>
        <p>Usable blocks: {{K.total_blocks}}</p>
        <p>Last block received {{timeAgo(K.ts)}}</p>
        <p>Network created {{timeAgo(K.created_at)}}</p>
        <p>Transactions: {{K.total_tx}}</p>
        <p>Total bytes: {{K.total_bytes}}</p>
        <h2>Governance stats</h2>
        <p>Smart updates created: {{K.proposals_created}}</p>
        <h2>Hard Fork</h2>
        <p>If validators vote for things you don't agree with, find like minded people and decide on a new validator set out-of-band. Then paste the code that changes validators below:</p>
        <div class="form-group">
          <label for="comment">Code to execute:</label>
          <textarea class="form-control" v-model="hardfork" rows="4" id="comment"></textarea>
        </div>
        <p>
          <button @click="call('hardfork', {hardfork: hardfork})" class="btn btn-danger">Execute Code</button>
        </p>
      </div>
      <div v-else-if="tab=='wallet'">
        <template v-if="pubkey">
          <h2 class="alert alert-primary" v-if="my_hub">This node is a hub @{{my_hub.handle}}</h2>
          <br>



          <div class="input-group mb-3" style="width:400px" >
            <input v-model="faucet_amount" type="text" class="form-control" placeholder="Amount to get" aria-label="Amount to get" aria-describedby="basic-addon2">
            <div class="input-group-append">
              <button class="btn btn-outline-secondary" type="button" @click="call('testnet', { partner: ch.partner, asset: asset, action: 1, faucet_amount: uncommy(faucet_amount) })">Testnet Faucet</button>
            </div>
          </div>


          <template v-for="(ch, index) in channels" v-if="ch.d.asset == asset" >
            <h2 style="display:inline-block">{{to_ticker(ch.d.asset)}} Balance @{{ch.hub.handle}}<span v-if="dev_mode"> {{ch.d.status}}</span>: {{commy(ch.payable)}}</h2>
            <small v-if="ch.payable > 0">
              = {{commy(ch.ins.insurance)}} insurance 
              {{ch.uninsured > 0 ? "+ "+commy(ch.uninsured)+" uninsured" : ''}}
              {{ch.they_insured > 0 ? "- "+commy(ch.they_insured)+" spent" : ''}}
              {{ch.hashlock_hold[1] > 0 ? "- "+commy(ch.hashlock_hold[1])+" hashlocks" : ''}}
              
              {{ch.d.they_hard_limit > 0 ? "+ "+commy(ch.d.they_hard_limit)+" uninsured limit" : ''}} 
              <span class="badge badge-dark" v-if="!my_hub && ch.d.hard_limit == ch.d.soft_limit && ch.hard_limit > 0 && ch.uninsured > 0" @click="">click to request insurance</span>
              <span title="Your uninsured balance has gone over the soft credit limit you set. It's expected for hub to rebalance you soon. If this doesn't happen you can start a dispute with a hub" class="badge badge-dark" v-if="!my_hub && ch.uninsured > ch.d.soft_limit">over soft limit, expect rebalance</span>
              <span title="When you spend large part of your insurance, the hub may request a withdrawal from you so they could deposit this insurance to someone else. It's recommended to come online more frequently, otherwise hub may start a dispute with you." class="badge badge-dark" v-if="!my_hub && ch.they_insured >= K.risk">stay online to cooperate</span>
            </small>
            <p>
              <div v-if="ch.bar > 0">
                <div class="progress" style="max-width:1400px">
                  <div v-bind:style="{ width: Math.round(ch.they_uninsured*100/ch.bar)+'%', 'background-color':'#0000FF'}" class="progress-bar" role="progressbar">
                    -{{commy(ch.they_uninsured)}} (they uninsured)
                  </div>
                  <div class="progress-bar" v-bind:style="{ width: Math.round(ch.insured*100/ch.bar)+'%', 'background-color':'#5cb85c'}" role="progressbar">
                    {{commy(ch.insured)}} (insured)
                  </div>
                  <div v-bind:style="{ width: Math.round(ch.they_insured*100/ch.bar)+'%', 'background-color':'#007bff'}" class="progress-bar" role="progressbar">
                    -{{commy(ch.they_insured)}} (spent)
                  </div>
                  <div v-bind:style="{ width: Math.round(ch.uninsured*100/ch.bar)+'%', 'background-color':'#dc3545'}" class="progress-bar" role="progressbar">
                    +{{commy(ch.uninsured)}} (uninsured)
                  </div>
                </div>
              </div>
            </p>
            
            <pre v-if="dev_mode" v-html="ch.ascii_channel"></pre>
            <pre v-if="dev_mode" v-html="ch.ascii_states"></pre>
          </template>
          <p style="word-wrap: break-word">Your Address: <b>{{address}}</b></p>
          <div class="col-sm-6">
            <p>
              <div class="input-group" style="width:400px">
                <input type="text" class="form-control small-input" v-model="outward_address" :disabled="['none','amount'].includes(outward_editable)" placeholder="Address" aria-describedby="basic-addon2">
              </div>
            </p>
            <p>
              <div class="input-group" style="width:400px">
                <input type="text" class="form-control small-input" v-model="outward_amount" :disabled="outward_editable=='none'" placeholder="Amount" aria-describedby="basic-addon2">
              </div>
            </p>
            <p>
              <div class="input-group" style="width:400px">
                <input type="text" class="form-control small-input" v-model="outward_invoice" :disabled="['none','amount'].includes(outward_editable)" placeholder="Private Message (optional)" aria-describedby="basic-addon2">
              </div>
            </p>
            <p>
              <button type="button" class="btn btn-success" @click="call('send', {address: outward_address, asset: asset, amount: uncommy(outward_amount), invoice: outward_invoice, addrisk: addrisk, lazy: lazy})">Pay Now → </button>

              <button type="button" class="btn btn-danger" @click="stream()">Pay 100 times</button>


            </p>

          </div>
          <table v-if="assetPayments(asset).length > 0" class="table">
            <thead>
              <tr>
                <th width="5%">Status</th>
                <th width="10%">Amount</th>
                <th width="65%">Details</th>
                <th width="20%">Date</th>
              </tr>
            </thead>

              <transition-group name="list" tag="tbody">


                <tr v-bind:key="h.id" v-for="(h, index) in assetPayments(asset).slice(0, history_limit)">
                  <td v-bind:title="h.id+h.type+h.status">{{payment_status(h)}}</td>
                  <td>{{commy(h.is_inward ? h.amount : -h.amount)}}</td>
                  <td @click="outward_address=h.is_inward ? h.refund_address : h.destination_address; outward_amount=commy(h.amount); outward_invoice = h.invoice"><u class="dotted">{{h.is_inward ? "From "+trim(h.refund_address): "To "+trim(h.destination_address)}}</u>: {{h.invoice}}</td>
                  <td v-html="skipDate(h, index)"></td>
                </tr>

              </transition-group>

              <tr v-if="assetPayments(asset).length > history_limit">
                <td colspan="7" align="center"><a @click="history_limit += 20">Show More</a></td>
              </tr>

          </table>
        </template>
        <form v-else class="form-signin" v-on:submit.prevent="call('load',{username, pw})">
          <label for="inputUsername" class="sr-only">Username</label>
          <input v-model="username" type="text" id="inputUsername" class="form-control" placeholder="Username" required autofocus>
          <br>
          <label for="inputPassword" class="sr-only">Password</label>
          <input v-model="pw" type="password" id="inputPassword" class="form-control" placeholder="Password" required>

          <p>Make sure you don't forget your password - <b>password recovery is not possible.</b> If in doubt, write it down or email it to yourself.</p>
          
          <button class="btn btn-lg btn-primary btn-block" id="login" type="submit">Generate Wallet</button>
        </form>
      </div>
      <div v-else-if="pubkey && tab=='credit'">
        <h3>Credit Limits</h3>
        <select v-model="partner" class="custom-select custom-select-lg mb-3">
          <option disabled>Select current hub</option>
          <option v-for="(a,index) in channels" v-if="a.d.asset == asset" :value="a.partner">@{{a.hub.handle}}</option>
        </select>

        <template v-if="ch">
          <p>In order to receive assets you must define <b>credit limits to a hub</b> below. This limits your risk (uninsured balances).</p>
          <p>
            <label>Soft limit (currently {{commy(ch.d.soft_limit)}}, recommended {{commy(K.risk)}}) tells the hub after what amount uninsured balances must be insured. Low soft limit makes the hub rebalance more often thus incurs higher rebalance fees.</label>
            <input v-once type="text" class="form-control col-lg-4" v-model="limits[0]">
          </p>
          <p>
            <label>Hard limit (currently {{commy(ch.d.hard_limit)}}, recommended 1000) defines a maximum uninsured balance you can have at any time. Low hard limit may prevent you from receiving large payments.</label>
            <input v-once type="text" class="form-control col-lg-4" v-model="limits[1]">
          </p>
          <p>If you want to request insurance manually, set soft limit equal to hard limit. Then you can click "request insurance" in your wallet but beware of expensive onchain fees.</p>
          
          <p>
            <button type="button" class="btn btn-danger" @click="call('setLimits', {limits: limits, partner: ch.partner})" href="#">Save Uninsured Limits</button>
          </p>

          <p>Wondering how much risk you are exposed to? This chart shows your uninsured balances over time and can help you to structure (stream) payments to reduce your risk to negligible amount.</p>
          <canvas width="100%" style="max-height: 200px" id="riskcanvas"></canvas>
        </template>
      </div>
      <div v-else-if="tab=='onchain'">
        <div v-if="record">
          <h1>Onchain Operations</h1>
          <p>Onchain ID: {{record.id}}</p>
          <p>Onchain {{to_ticker(asset)}} balance: {{commy(getAsset(asset))}}</p>
          
          <template>
            <h3>Withdraw from hub</h3>
            <template v-if="ch && ch.insured>0">
              
              <small>Amount to withdraw (up to <b>{{commy(ch.insured)}}</b>) from <b>insured</b> balance
              .</small>
              <p>
                <input style="width:300px" type="text" class="form-control small-input" v-model="request_amount" placeholder="Amount to withdraw">
              </p>
            </template>
            <p v-else>You do not have <b>insured</b> balances to withdraw from.</p>
          </template>

          <h3>Deposits to channels or users</h3>
          <div v-for="out in outs">
            <p><input style="width:300px" type="text" class="form-control small-input" v-model="out.to" placeholder="ID or ID@hub"></p>
            <p><input style="width:300px" type="text" class="form-control small-input" v-model="out.amount" placeholder="Amount to deposit"></p>
            <p><input style="width:300px" type="text" class="form-control small-input" v-model="out.invoice" placeholder="Public Message (optional)"></p>
            <hr />
          </div>
          <p>
            <button type="button" class="btn btn-success" @click="outs.push({to:'',amount: '', invoice:''})">+ Another Deposit</button>
          </p>
          <hr />

          <p>
            <button type="button" class="btn btn-warning" @click="onchain()">Execute Onchain</button>
          </p>

          <template v-if="ch">
            <p>If the hub becomes unresponsive, doesn't honor your soft limit and insure your balances, fails to process your payments or anything else: you can always start a dispute onchain. You are guaranteed to get {{commy(ch.insured)}} (<b>insured</b> part of your balance), but you may lose up to {{commy(ch.uninsured)}} (<b>uninsured</b> balance) if the hub is completely compromised.
            </p>
            <p>After a timeout assets will arrive to your onchain balance, then you will be able to move it to another hub.</p>
            <p v-if="ch.d.status == 'disputed'">
              Please wait for dispute resolution. <span v-if="ch.ins.dispute_delayed > 0">Will be resolved at block {{ch.ins.dispute_delayed}}</span>
            </p>
            <p v-else-if="getAsset(1) >= K.standalone_balance">
              <button class="btn btn-danger" @click="call('dispute', {partner: ch.partner})" href="#">Start Dispute</button>
            </p>
            <p v-else>To start onchain dispute you must be registred onchain and have on your onchain balance at least {{commy(K.standalone_balance)}} FRD to cover transaction fees. Please ask another hub or user to register you and/or deposit FRD to your onchain balance.</p>
          </template>


        </div>
        <div v-else>
          <h3>Registration</h3>
          <p>You are not currently registered on the blockchain. Onchain registration is not required but it allows you to insure your balances, start disputes with hubs and do rebalances yourself. Your account will be registered automatically once you have more assets in uninsured balances. </p>
          <p>Otherwise you can ask someone to rebalance onchain at least $10 to your temporary ID:
            <br>
            <b>{{pubkey}}</b></p>
        </div>
      </div>
      <div v-else-if="tab=='testnet'">
        <h3>Testnet Actions</h3>

        <p>Case 5. If the hub tries to censor you and didn't let to withdraw the nice way, you can do the ugly way: start onchain dispute under Onchain disputes tab. (Notice that after a dispute uninsured limits are reset to 0 i.e. you reset your trust to the hub)</p>
        <p>Case 6. More than that, you can try to cheat on the hub with the button below: it will broadcase the most profitable state - biggest balance you ever owned. When hub notices that, they will post latest state before delay period. Keep an eye on Blockchain Explorer page to see that.</p>
        <button class="btn btn-success mb-3" @click="call('dispute', {partner: ch.partner, profitable: true})" href="#">Cheat in Dispute</button>
        <br>
        <p>Case 7. If you've been offline for too long, and the hub tried to get a withdrawal from you, they would have to dispute the channel with you.</p>
        <button class="btn btn-success mb-3" @click="call('testnet', { partner: ch.partner, action: 2 })">Ask Hub to Start Dispute</button>
        <br>
        <p>Case 8. Using this button you can ensure you're safe if the hub also tries to cheat on you with most profitable state.</p>
        <button class="btn btn-success mb-3" @click="call('testnet', { partner: ch.partner, action: 3 })">Ask Hub to Cheat in Dispute</button>

        <button class="btn btn-success mb-3" @click="call('testnet', { partner: ch.partner, action: 4 })">CHEAT dontack</button>
        <button class="btn btn-success mb-3" @click="call('testnet', { partner: ch.partner, action: 5 })">CHEAT dontreveal</button>
        <button class="btn btn-success mb-3" @click="call('testnet', { partner: ch.partner, action: 6 })">CHEAT dontwithdraw</button>
      </div>
      <div v-else-if="tab=='exchange'">
        <h3>Trustless Onchain Exchange</h3>
        <p>Onchain exchange is best suitable for large atomic swaps between two assets - it always incurs an expensive fees but is free of any counterparty risk. If you're looking to trade frequently or small amounts, try any exchange that supports Fair assets.</p>
        <hr/>

        <p>Amount of {{to_ticker(asset)}} you want to sell (you have {{commy(getAsset(asset))}}):</p>
        <p><input style="width:300px" class="form-control small-input" v-model="order.amount" placeholder="Amount to sell" @input="estimate(false)">
        </p>
        <p>Asset you are buying (you have {{commy(getAsset(order.buyAssetId))}}):</p>
        <p>
          <select v-model="order.buyAssetId" class="custom-select custom-select-lg lg-3">
            <option v-for="(a,index) in assets" v-if="a.id!=asset" :value="a.id">{{a.name}} ({{a.ticker}})</option>
          </select>
        </p>

        <p>Rate {{[asset, order.buyAssetId].sort().reverse().map(to_ticker).join('/')}}:</p>
        <p><input style="width:300px" class="form-control small-input" v-model="order.rate" placeholder="Rate"  @input="estimate(false)"></p>

        <p>{{to_ticker(order.buyAssetId)}} you will get:</p>
        <p><input style="width:300px" class="form-control small-input" v-model="order.buyAmount" @input="estimate(true)"></p>

        <div v-if="![asset, order.buyAssetId].includes(1)" class="alert alert-danger">You are trading pair without FRD, beware of small orderbook and lower liquidity in direct pairs.</div>

        <p v-if="pubkey && record && getAsset(1) > 200">
          <button type="button" class="btn btn-warning" @click="call('createOrder', {order: order, asset: asset})">Create Order</button>
        </p>
        <p v-else>In order to trade you must have a registered account with FRD balance.</p>


        <table v-if="orders.length>0" class="table">
          <thead class="thead-dark">
            <tr>
              <th scope="col">#</th>
              <th scope="col">Seller ID</th>
              <th scope="col">Sell Asset </th>
              <th scope="col">Pair</th>
              <th scope="col">Amount</th>
              <th scope="col">Rate</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="b in orders">
              <tr>
                <td>{{b.id}}</td>
                <td>{{b.userId}}</td>
                <td>{{to_ticker(b.assetId)}}</td>
                <td>{{[b.assetId, b.buyAssetId].sort().reverse().map(to_ticker).join('/')}}</td>
                <td>{{commy(b.amount)}}</td>
                <td>{{b.rate.toFixed(6)}}</td>
                <td v-if="record && record.id == b.userId"><button  @click="call('cancelOrder', {id: b.id})" class="btn btn-success">Cancel</button></td>
                <td v-else><button class="btn btn-success"  @click="order.amount = buyAmount(b); order.rate = b.rate; order.buyAssetId=b.assetId; asset = b.buyAssetId; estimate(false)">Fulfill</td>
              </tr>
            </template>
          </tbody>
        </table>

      </div>
      <div v-else-if="tab=='install'">
        <h3>Decentralized Install for macOS/Linux/Windows</h3>
        <p>Install <a href="https://nodejs.org/en/download/">Node.js</a> (9.6.0+) and copy paste this snippet into your Terminal app:</p>
        <div style="background-color: #FFFDDE; padding-left: 10px;"><Highlight :white="true" lang="bash" :code="install_snippet"></Highlight></div>
        <p><b>For higher security</b> visit a few trusted nodes below and verify the snippet to ensure our server isn't compromised. Only paste the snippet into Terminal if there is exact match with other sources.</p>

        <ul>
          <li v-for="m in K.members" v-if="m.website && (!my_member || m.id != my_member.id)"><a v-bind:href="m.website+'/#install'">{{m.website}} - by {{m.username}} ({{m.platform}})</a></li>
        </ul>


      </div>
      <div v-else-if="tab=='gov'">
        <h3>Smart Updates</h3>
        <div class="form-group">
          <label for="comment">Description:</label>
          <textarea class="form-control" v-model="proposal[0]" rows="2" id="comment"></textarea>
        </div>
        <div class="form-group">
          <label for="comment">Code to execute (optional):</label>
          <textarea class="form-control" v-model="proposal[1]" rows="2" id="comment"></textarea>
        </div>
        <div class="form-group">
          <input class="form-check-input" type="checkbox" v-model="proposal[2]"> Add patch
          
        </div>
        <p v-if="my_member">
          <button @click="call('propose', proposal)" class="btn btn-warning">Propose</button>
        </p>
        <p v-else>Currently only stakeholders can submit a new amendment.</p>
        <div v-for="p in proposals">
          <h4>#{{p.id}}: {{p.desc}}</h4>
          <small>Proposed by #{{p.user.id}}</small>
          <UserIcon :hash="p.user.pubkey" :size="30"></UserIcon>
          <Highlight lang="javascript" :code="p.code"></Highlight>
          <div v-if="p.patch">
            <hr>
            <div style="line-height:15px; font-size:12px;">
              <Highlight lang="diff" :code="p.patch"></Highlight>
            </div>
          </div>
          <p v-for="u in p.voters">
            <UserIcon :hash="u.pubkey" :size="30"></UserIcon>
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
        <table v-if="blocks.length>0" class="table">
          <thead class="thead-dark">
            <tr>
              <th scope="col">#</th>
              <th scope="col">Prev Hash</th>
              <th scope="col">Hash</th>
              <th scope="col">Relayed By</th>

              <th scope="col">Total Tx</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="b in blocks">
              <tr>
                <td>{{b.id}}</td>
                <td>{{b.prev_hash.substr(0,10)}}</td>
                <td>{{b.hash.substr(0,10)}}</td>
                <td>{{b.built_by}} ({{timeAgo(b.timestamp)}})</td>

                <td>{{b.total_tx}}</td>
              </tr>
              <tr v-for="batch in (b.meta && b.meta.parsed_tx)">
                <td colspan="7">
                  <span class="badge badge-warning">By {{batch.signer.id}} ({{commy(batch.tax)}} fee, size {{batch.length}}):</span>&nbsp;
                  <template v-for="d in batch.events">
                    &nbsp;

                    <span v-if="d[0]=='disputeWith'" class="badge badge-primary" v-html="dispute_outcome(d[2], d[3], d[4])">
                    </span>


                    <span v-else-if="d[0]=='setAsset'" class="badge badge-dark">Set asset: {{to_ticker(d[1])}}</span>

                    <span v-else-if="d[0]=='withdrawFrom'" class="badge badge-danger">{{commy(d[1])}} from {{d[2]}}</span>

                    <span v-else-if="d[0]=='revealSecrets'" class="badge badge-danger">Secret revealed: {{trim(d[1])}}</span>

                    <span v-else-if="d[0]=='enforceDebt'" class="badge badge-dark">{{commy(d[1])}} debt to {{d[2]}}</span>

                    <span v-else-if="d[0]=='depositTo'" class="badge badge-success" >{{commy(d[1])}} to {{d[3] ? ((d[2] == batch.signer.id ? '': d[2])+'@'+d[3]) : d[2]}}{{d[4] ? ' for '+d[4] : ''}}</span>

                    <span v-else-if="d[0]=='createOrder'" class="badge badge-dark">Created order {{commy(d[2])}} {{to_ticker(d[1])}} for {{to_ticker(d[3])}}</span>

                    <span v-else-if="d[0]=='cancelOrder'" class="badge badge-dark">Cancelled order {{d[1]}}</span>

                    <span v-else-if="d[0]=='createAsset'" class="badge badge-dark">Created {{commy(d[2])}} of asset {{d[1]}}</span>
                    
                    <span v-else-if="d[0]=='createHub'" class="badge badge-dark">Created hub {{d[1]}}</span>

                  </template>
                </td>
              </tr>
              <tr v-if="b.meta">
                <td v-if="b.meta.cron.length + b.meta.missed_validators.length > 0"  colspan="7">
                  <template v-if="b.meta.cron.length > 0" v-for="m in b.meta.cron">
                    <span v-if="m[0] == 'maturity'" class="badge badge-primary">🎉 Maturity day! All FRB balances are copied to FRD balances.</span>

                    <span v-else-if="m[0] == 'resolved'" class="badge badge-primary" v-html="dispute_outcome(m[0], m[1], m[2])"></span>
                    <span v-else-if="m[0] == 'snapshot'" class="badge badge-primary">Generated a new snapshot at #{{m[1]}}</span>
                    <span v-else-if="m[0] == 'executed'" class="badge badge-primary">Proposal {{m[1]}} gained majority vote and was executed</span> &nbsp;
                  </template>

                  <span v-if="b.meta.missed_validators.length > 0" class="badge badge-danger">Missed signatures from validators: {{b.meta.missed_validators.join(', ')}}</span>

                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <div v-else>
        <p><b>No blocks stored on this node.</b></p>
        </div>
      </div>
      <div v-else-if="tab=='account_explorer'">
        <h1>Account Explorer</h1>
        <p>This is a table of registered users in the network. Onchain balance is normally used to pay transaction fees, and most assets are stored in payment channels under Channel Explorer.</p>
        <table class="table table-striped">
          <thead class="thead-dark">
            <tr>
              <th scope="col">Icon</th>
              <th scope="col">ID</th>
              <th scope="col">Name</th>
              <th scope="col">Pubkey</th>
              <th scope="col">FRD/FRB</th>
              <th scope="col">Other Assets</th>
              <th scope="col">Nonce</th>
              <th scope="col">Debts</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users">
              <th>
                <UserIcon :hash="u.pubkey" :size="30"></UserIcon>
              </th>
              <th scope="row">{{u.id}}</th>
              <td>{{u.username}}</td>
              <td><small>{{u.pubkey.substr(0,10)}}..</small></td>

              <td>{{commy(u.balance1)}} / {{commy(u.balance2)}}</td>
              <td>{{parse_balances(u.balances)}}</td>
              <td>{{u.nonce}}</td>
              <td>{{u.debts.length}}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else-if="tab=='channel_explorer'">
        <h1>Insurance Explorer</h1>
        <p>Insurances represent collateral between two parties.</p>
        <table class="table table-striped">
          <thead class="thead-dark">
            <tr>
              <th scope="col">Left ID</th>
              <th scope="col">Right ID</th>
              <th scope="col">Asset</th>
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
              <th>{{to_ticker(u.asset)}}</th>
              <th>{{commy(u.insurance)}}</th>
              <th>{{commy(u.ondelta)}}</th>
              <th>{{u.nonce}}</th>
              <th>{{u.dispute_delayed ? "Until "+u.dispute_delayed+" started by "+(u.dispute_left ? u.leftId : u.rightId) : "N/A" }}</th>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else-if="tab=='hashlocks'">
        <h1>Hashlocks</h1>
        <p>Each payment with hashlock is atomic and protected from any party misbehaving. If your partner doesn't ack when you return the secret, your wallet reveals the secret to blockchain publicly. It will be stored for a while (about a week) and your hashlock will be considered unlocked. Make sure to end your disputes until the hashlock is deleted from blockchain. It is a global evidence that the payment was executed.</p>
        <table class="table table-striped">
          <thead class="thead-dark">
            <tr>
              <th scope="col">Hash</th>
              <th scope="col">Revealed At</th>
              <th scope="col">Delete At</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in hashlocks">
              <th>{{u.hash}}</th>
              <th>{{u.revealed_at}}</th>
              <th>{{u.delete_at}}</th>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else-if="tab=='hubs'">
        <h1>Hubs</h1>
        <p>Any user can have a payment channel with any other user. However for effective routing some users get thoroughly verified and offered inside the wallet to have channel with. Similarly to banks, using same hub with recipients is cheaper then sending assets cross-hub. Hubs have no priveleges over regular users and follow exact same rules and cannot steal your assets like a bank. If your hub is compromised the uninsured balances may be lost, but insured are protected.</p>
        <table class="table table-striped">
          <thead class="thead-dark">
            <tr>
              <th scope="col">#</th>
              <th scope="col">Name</th>
              <th scope="col">Fee</th>
              <th scope="col">Location</th>
              <th scope="col">Total FRD Insurances</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in K.hubs">
              <th>{{u.id}}</th>
              <th>{{u.name}}</th>
              <th>{{u.fee}}</th>
              <th>{{u.location}}</th>
              <th>{{commy(u.sumForUser)}}</th>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else-if="tab=='assets'">
        <h1>Assets</h1>
        <p>Fair assets is the name for all kinds of fiat/crypto-currencies, tokens and stock you can create on top of the system.</p>


        <div class="form-group">
          <p><label for="comment">Name:</label>
          <input class="form-control" v-model="new_asset.name" rows="2" id="comment"></input></p>

          <p><label for="comment">Ticker (must be unique):</label>
          <input class="form-control" v-model="new_asset.ticker" rows="2" id="comment"></input></p>
          
          <p><label for="comment">Amount:</label>
          <input class="form-control" v-model="new_asset.amount" rows="2" id="comment"></input></p>

          <p><label for="comment">Division point (e.g. 0 for yen, 2 for dollar):</label>
          <input class="form-control" v-model="new_asset.division" rows="2" id="comment"></input></p>

          <p><label for="comment">Description:</label>
          <input class="form-control" v-model="new_asset.desc" rows="2" id="comment"></input></p>

          <p v-if="record"><button class="btn btn-success" @click="call('createAsset', new_asset)">Create Asset</button></p>
          <p v-else>In order to create your own asset you must have a registered account with FRD balance.</p>

          <div class="alert alert-primary">After creation the entire supply will appear on your onchain balance, then you can rebalance it to a channel with a hub and start sending instantly to other users.</div>
        </div>
          





        <table class="table table-striped">
          <thead class="thead-dark">
            <tr>
              <th scope="col">Ticker</th>
              <th scope="col">Name</th>
              <th scope="col">Description</th>
              <th scope="col">Total Supply</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in assets">
              <th>{{u.ticker}}</th>
              <th>{{u.name}}</th>
              <th>{{u.desc}}</th>
              <th>{{commy(u.total_supply)}}</th>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
