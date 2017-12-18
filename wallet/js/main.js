
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
    settle: ()=>{
      var total = app.outs.reduce((k,v)=>k+parseFloat(v.amount.length==0 ? '0' : v.amount), 0)

      if(confirm("Total outputs "+total)){
        app.call('settleUser', {
          assetType: 0,
          ins: app.ins,
          outs: app.outs
        })
      }
    },
    derive: f=>{
      var data = {
        username: inputUsername.value, 
        password: inputPassword.value
      }


      W('load', data).then(render)
      return false
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
    },

    timeAgo: (time)=>{
      var units = [
        { name: "second", limit: 60, in_seconds: 1 },
        { name: "minute", limit: 3600, in_seconds: 60 },
        { name: "hour", limit: 86400, in_seconds: 3600  },
        { name: "day", limit: 604800, in_seconds: 86400 },
        { name: "week", limit: 2629743, in_seconds: 604800  },
        { name: "month", limit: 31556926, in_seconds: 2629743 },
        { name: "year", limit: null, in_seconds: 31556926 }
      ];
      var diff = (new Date() - new Date(time*1000)) / 1000;
      if (diff < 5) return "now";
      
      var i = 0, unit;
      while (unit = units[i++]) {
        if (diff < unit.limit || !unit.limit){
          var diff =  Math.floor(diff / unit.in_seconds);
          return diff + " " + unit.name + (diff>1 ? "s" : "") + " ago";
        }
      };
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
      location: '0.0.0.0:8000',

      channels: {},

      record: false,

      ins: [],
      outs: [{to:'', amount:''}]

    } },
    methods: methods,
    template: `
    <div>
      <p v-if="false">Current asset: <select v-model="assetType">
        <option v-for="asset in K.assets" v-bind:value="asset.ticker">
         {{asset.ticker}} ({{ asset.name }})
        </option>
      </select></p>

      <template v-if="pubkey">
        <h5>Hello, <b>{{username}}</b>! Your ID is <b>{{record ? record.id : pubkey}}</b></h5>
        
      <p class="lead">Send and receive money through the hub:</p>  
        <h1 style="display:inline-block">Balance: \${{commy(collateral + last_delta)}}</h1><small v-if="hub_total>0">= {{commy(collateral)}} (collateral) {{last_delta > 0 ? "+ "+commy(last_delta) : "- "+commy(-last_delta)}} (delta)</small> 
      <p>


      <div v-if="hub_total>0">
        <div class="progress" style="max-width:800px">
          <div class="progress-bar" v-bind:style="{ width: Math.round(hub_failsafe*100/(last_delta<0?collateral:hub_total))+'%', 'background-color':'#5cb85c'}" role="progressbar">
            Insured {{commy(hub_failsafe)}}
          </div>
          <div v-if="last_delta<0" v-bind:style="{ width: Math.round(-last_delta*100/collateral)+'%', 'background-color':'#5bc0de'}"  class="progress-bar progress-bar-striped" role="progressbar">
            Spent {{commy(last_delta)}}
          </div>
          <div v-if="last_delta>0" v-bind:style="{ width: Math.round(last_delta*100/hub_total)+'%', 'background-color':'#f0ad4e'}"   class="progress-bar"  role="progressbar">
            Risky +{{commy(last_delta)}}
          </div>
        </div>
        </p>

        <p>
          <input style="width:800px" type="text" class="form-control small-input" v-model="off_to" placeholder="ID">
          <input style="width:200px" type="number" class="form-control small-input" v-model="off_amount" placeholder="Amount">
        </p>

        <button type="button" class="btn btn-success" @click="call('send', {off_to, off_amount})">Instant Send</button>\
      </div>



        <p v-if="my_member">You're member with {{my_member.shares}} shares and advertised location at {{my_member.location}}.</p>

        <hr><br><br>

        <template v-if="record">
          <p class="lead">Or settle globally (slow, expensive, but more secure):</p>
          <p>Standalone balance: <b>\${{commy(record.balance)}}</b></p>

          <p v-for="out in outs">
            <input style="width:800px" type="text" class="form-control small-input" v-model="out.to" placeholder="ID or ID@hub">
            <input style="width:200px" type="number" class="form-control small-input" v-model="out.amount" placeholder="Amount">
          </p>
       
          <button type="button" class="btn btn-success" @click="outs.push({to:'',amount: ''})">Add output</button>

          <button type="button" class="btn btn-warning" @click="settle()">Settle Globally</button>

          <transition name="fade" mode="in-out">
            <b v-if="pending">
            Global transaction is broadcasted. Please wait for it to be confirmed.
            </b>
          </transition>



        </template>

     <hr>

      <button type="button" class="btn btn-info" @click="call('sync')">Sync (Height {{K.total_blocks}}, {{timeAgo(K.ts)}})</button>

      <button type="button" class="btn btn-danger" @click="call('logout')">Log Out</button>


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







