
l=console.log

render = r=>{
  l('Rendering ',r)
  if(r.error) alert(r.error)

  Object.assign(app, r)
}


W.onready(()=>{
  W('load').then(render)

  setInterval(function(){
    W('load').then(render)
  }, 3000)      


  var methods = {
    call: function(method, args){
      console.log(args)
      W(method, args).then(render)
      return false
    },
    derive: f=>{
      var data = {
        username: inputUsername.value, 
        password: inputPassword.value
      }


      W('load', data).then(render)
      return false
    },
    logout: async f=>{
      await W('logout')
      location.reload()
    },

    commy: (b,dot=true)=>{
      b = b.toString()
      if(dot){
        if(b.length==1){
          b='0.0'+b
        }else if(b.length==2){
          b='0.'+b
        }else{
          var insert_dot_at = b.length - 2
          b = b.slice(0,insert_dot_at) + '.' + b.slice(insert_dot_at)
        }
      }
      return b.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    },
    uncommy: str=>{
      if(str.indexOf('.') == -1) str += '.00'

      return parseInt(str.replace(/[^0-9]/g,''))
    }


  }



  app = new Vue({
    el: '#app',
    data(){ return {
      assetType: 'FSD',
      pending: false,
      pubkey: false,
      K: false,
      my_member: false,

      pw: 'password',
      username: 'root',
      location: '0.0.0.0',

      channels: {},

      record: false,

      ins: [],
      outs: [{to:'', amount:''}]

    } },
    methods: methods,
    template: `
    <div>
      <template v-if="pubkey">
        <p>ID: <b>{{ pubkey }}</b></p>

        <p>Transact in: <select v-model="assetType"  >
          <option v-for="asset in K.assets" v-bind:value="asset.ticker">
           {{asset.ticker}} ({{ asset.name }})
          </option>
        </select></p>

        <template v-if="record">
          <p>Short ID: {{record.id}}</p>
          <p>FSD balance: {{commy(record.balance)}}</p>
          <p>FSB balance: {{commy(record.fsb_balance)}}</p>
          <p>Settle on-chain:</p>

          <p>Inputs:</p>
          Channels


          <p>Outputs:</p>

          <p v-for="out in outs">
            <input style="width:800px" type="text" class="form-control small-input" v-model="out.to" placeholder="ID or ID@hub">
            <input style="width:200px" type="number" class="form-control small-input" v-model="out.amount" placeholder="Amount">
          </p>
       
          <button type="button" class="btn btn-success" @click="outs.push({to:'',amount: ''})">Add output</button>\

          <p>Total amount of inputs: {{commy(record.balance)}}</p>
          <p>Total amount of outputs: {{outs.reduce((k,v)=>k+parseFloat(v.amount.length==0 ? '0' : v.amount), 0)}}</p>

          <button type="button" class="btn btn-warning" @click="call('settleUser',{assetType, ins, outs})">Settle</button>
          <transition name="fade" mode="in-out">
            <b v-if="pending">
            On-chain transaction is broadcasted. Please wait up to 30 minutes.
            </b>
          </transition>



        </template>

<hr>
        Send/receive off-chain 

        <p>@sf</p>
        <p>

          Hub balance is $2,332 which is sum of collateral and delta: 2,000+332

        </p>
        <p v-if="my_member">You're member with {{my_member.shares}} shares and advertised location at {{my_member.location}}.</p>

        <button @click="call('logout')">Log Out</button>
      </template>
      <form v-else class="form-signin" v-on:submit.prevent="call('load',{username, pw, location})">

        <label for="inputUsername" class="sr-only">Username</label>
        <input v-model="username" type="text" id="inputUsername" class="form-control" placeholder="Username" required autofocus>
        <br>

        <p>Make sure your password is unique, strong and don't forget it, otherwise access to your account is lost. If in doubt, write it down or email it to yourself. </p>

        <label for="inputPassword" class="sr-only">Password</label>
        <input v-model="pw" type="password" id="inputPassword" class="form-control" placeholder="Password" required>

        <p>There's no password recovery procedure because FN is decentralized and no one can generate your private key without your password.
        </p>

        <template v-if="!K">
          <p>No members found. Would you like to start private fs? Enter your IP:</p>
          <input v-model="location" type="text" id="inputLocation" class="form-control" value="0.0.0.0"><br>
        </template>


        <button class="btn btn-lg btn-primary btn-block" id="login" type="submit">Log In</button>
      </form>
    </div>
     ` 
   })



})

/*

<p id="decentText"></p>
<canvas id="decentChart"></canvas>
*/







