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

    this.interval = setInterval(function() {
      app.call('load')
    }, localStorage.auth_code ? 6000 : 80000)
  

    setInterval(() => app.$forceUpdate(), 1000)
  },
  destroyed() {
    clearInterval(this.interval)
  },
  data() {
    return {
      onServer: location.hostname!='127.0.0.1',
      auth_code: localStorage.auth_code,

      asset: hashargs['asset'] ? parseInt(hashargs['asset']) : 1,

      bestRoutes: [],

      bestRoutesLimit: 5,

      chosenRoute: 0,

      gasprice: 1, 

      assets: [],
      orders: [],
      channels: [],
      payments: [],


      
      new_asset: {
        name: 'Yen ¥',
        ticker: 'YEN',
        amount: 100000000000,
        desc:
          'This asset represents Japanese Yen and is backed by the Bank of Japan.'
      },


      new_hub: {
        handle: "YAY",
        location:  `ws://${location.hostname}:${parseInt(location.port)+100}`,
        fee_bps: 10,
        add_routes: '1',
        remove_routes: ''
      },

      pubkey: false,
      K: false,
      PK: false,

      my_validator: false,

      pw: '',
      username: '',

      record: false,

      tab: '',

      install_snippet: false,


      chActions: {},

      externalDeposits: [],

      off_to: '',
      off_amount: '',

      my_hub: false,


      metrics: {},

      history_limit: 10,

      blocks: [],
      users: [],

      history: [],

      proposal: [
        'Increase Blocksize After Client Optimization',
        `K.blocksize += 1000000;`,
        ''
      ],

      proposals: [],
      set_name: '',

      settings: !localStorage.settings,

      outward_address: hashargs['address'] ? hashargs['address'] : '',
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
      dev_mode: false,
      sync_started_at: false
    }
  },
  computed: {
    current_ch: () => {
      // find current channel for selected asset and hub

      let chan = app.channels
        ? app.channels.find(
            (c) => c.partner == app.partner && c.d.asset == app.asset
          )
        : false

      return chan
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

    updateRoutes: ()=>{
      l("updatingg")
      // address or amount was changed - recalculate best offered routes
      app.call('getRoutes', {
        address: app.outward_address,
        amount: app.uncommy(app.outward_amount),
        asset: app.asset
      })
    },

    routeToText: (r)=>{
      let info = "";

      for (let hop of r[1]) {
        let hub = app.K.hubs.find(h => h.id == hop);
        if (hub) {
          info += `@${app.to_user(hub.id)} (${app.bpsToPercent(hub.fee_bps)}) → `;
        }
      }

      return info 
    },

    bpsToPercent: (p)=>{
        return app.commy(p) + "%";
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
        return str.split(', ')[1] + ', <b>' + str.split(', ')[0] + '</b>'
      }
    },

    paymentsForAsset: (asset = app.asset) => {
      return app.payments.filter((p) => p.asset == asset)
    },

    toHexString: (byteArray) => {
      return Array.prototype.map
        .call(byteArray, function(byte) {
          return ('0' + (byte & 0xff).toString(16)).slice(-2)
        })
        .join('')
    },

    chAction: (ch)=>{
      if (!app.chActions[ch.d.id]) {
        app.chActions[ch.d.id] = {
          depositAmount: '0',
          withdrawAmount: '0',
          startDispute: false,
          hard_limit: app.commy(ch.d.hard_limit), 
          soft_limit: app.commy(ch.d.soft_limit)
        }
      }

      return app.chActions[ch.d.id]

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

    channelsForAsset: (asset = app.asset) => {
      return app.channels.filter(c=>c.d.asset == asset)
    },

    setLimits: () => {
      let selectedActions = []
      let channels = app.channelsForAsset()

      for (let i in channels) {
        let raw = app.chAction(channels[i])

        let a = {
          partnerId: channels[i].d.partnerId,
          asset: channels[i].d.asset,
          hard_limit: app.uncommy(raw.hard_limit),
          soft_limit: app.uncommy(raw.soft_limit),
          request_insurance: raw.request_insurance,
        }

        selectedActions.push(a)
      }

      app.call('setLimits', {
        asset: app.asset,
        chActions: selectedActions
      })
    
      // reset all formfields
      app.chActions = {}    
    },
    onchainPrepare: () => {
      // only send currently visible actions (some are hidden) and uncommy them
      let selectedActions = []
      let channels = app.channelsForAsset()

      for (let i in channels) {
        let raw = app.chAction(channels[i])

        let a = {
          withdrawAmount: app.uncommy(raw.withdrawAmount),
          depositAmount: app.uncommy(raw.depositAmount),
          startDispute: raw.startDispute,
          partnerId: channels[i].d.partnerId,
          asset: channels[i].d.asset
        }

        // some mistake checks

        if (a.withdrawAmount > 0 && a.depositAmount > 0) {
          alert("There's no need to withdraw and deposit at the same time from one channel")
          return false
        }

        if (raw.startDispute && (a.withdrawAmount + a.depositAmount > 0)) {
          alert("You cannot withdraw/deposit and start dispute at the same time")
          return false
        }
        selectedActions.push(a)
      }

      app.call('rebalance', {
        asset: app.asset,
        chActions: selectedActions,
        externalDeposits: app.externalDeposits.map(dep=>{
          return {
            depositAmount: app.uncommy(dep.depositAmount),
            hub: dep.hub,
            to: dep.to,
            invoice: dep.invoice
          }
        }),
      })
      
      // reset all formfields
      app.chActions = {}
      app.externalDeposits = []

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

    to_user: (userId) => {
      // todo: twitter-style tooltips with info on the user

      let h = app.K.hubs.find((h) => h.id == userId)
      //`<span class="badge badge-success">@${h.handle}</span>`
      return h ? h.handle : userId
    },

    getAsset: (asset, user) => {
      if (!user) user = app.record
      if (!user) return 0

      if (user['balance' + asset]) {
        return user['balance' + asset]
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

    showGraph: ()=>{
      if (!window.hubgraph) return

      drawHubgraph({
        nodes: app.K.hubs.map((h) => {
          return {id: h.id, handle: h.handle, group: 1}
        }),
        links: app.K.routes.map((r) => {
          return {source: r[0], target: r[1], value: 1}
        })
      })
    },



    go: (path) => {
      var authed = ['wallet', 'onchain', 'testnet']

      //if (authed.includes(path) && !localStorage.auth_code) path = ''


      if (path == '') {
        history.pushState('/', null, '/')
      } else {
        location.hash = '#' + path
      }

      app.tab = path


      
      app.showGraph()
      
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
        o += `${parts.insured > 0 ? c(parts.insured) : ''}${sep}${
          parts.they_insured > 0 ? c(parts.they_insured) : ''
        }`
      }
      return `${prefix} (${app.to_user(ins.leftId)}) ${o} (${app.to_user(
        ins.rightId
      )})`
    },

    commy: (b, dot = true) => {
      let prefix = b < 0 ? '-' : ''

      b = Math.abs(Math.round(b)).toString()
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
      if (str == '' || !str) return 0
      //if (str.indexOf('.') == -1) str += '.00'

      // commas are removed as they are just separators 
      str = str.replace(/,/g,'')

      return Math.round(parseFloat(str) * 100) 

      //parseInt(str.replace(/[^0-9]/g, ''))
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

    prompt: (a) => {
      return window.prompt(a)
    },

    totalWithdrawals: ()=>{
      let total = 0
      app.channelsForAsset().map(ch=>{
        total += app.uncommy(app.chAction(ch).withdrawAmount)
      })

      return Number.isInteger(total) ? total : 0
    },

    totalDeposits: ()=>{
      let total = 0
      app.channelsForAsset().map(ch=>{
        total += app.uncommy(app.chAction(ch).depositAmount)
      })
      for (let dep of app.externalDeposits) {
        total += app.uncommy(dep.depositAmount)
      }
      return total
    },

    afterRebalance: ()=>{
      return app.getAsset(app.asset) + app.totalWithdrawals() - app.totalDeposits()
    },

    trim: (str) => {
      return str ? str.slice(0, 8) + '...' : ''
    },
    payment_status: (t) => {
      var s = ''
      if (t.type == 'del' || t.type == 'delrisk') {
        s = t.secret && t.secret.length == 64 ? '✔' : '❌'
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