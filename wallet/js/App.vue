<template>
  <div>
    <template v-if="PK.pending_batch || (batch && batch.length > 0)">
      <div style="position:fixed;
      z-index:999999;
      opacity:0.9;
      bottom:0px;
      width:100%;
      height:100px;
      background-color: #FFFDDE; border:thin solid #EDDD00">
        <p v-if="PK.pending_batch" style='margin: 25px;text-align:center'>
          Wait for tx to be included in next block...
          <dotsloader></dotsloader>
        </p>
        <p v-else style='margin: 10px;text-align:center'>
          <span v-html="prettyBatch(batch)"></span>
          <span>
            <input style="width: 80px" type="number" v-model="gasprice">
     (gas price) * {{batch_estimate.size}} (gas) = fee {{commy(gasprice * batch_estimate.size)}}
            </span>
          <!--<div class="slidecontainer" style="display:inline-block; width: 100px">
              <input type="range" min="1" max="100" class="slider" v-model="gasprice">
            </div>-->
          <span v-if="getAsset(1) - gasprice * batch_estimate.size >= 100"><button type="button" class="btn btn-outline-danger" @click="call('broadcast', {gasprice: parseInt(gasprice)})">Sign & Broadcast</button> or <a class="dotted" @click="call('clearBatch')">clear batch</a></span>
          <span v-else>Not enough FRD in {{onchain}}</span>
        </p>
      </div>
    </template>
    <nav class="navbar navbar-expand-md navbar navbar-dark bg-dark">
      <!--<a class="navbar-brand" href="#" style="padding: 10px">fairlayer</a>-->
      <button class="navbar-toggler" type="button" data-toggle="collapse" data-target="#navbarCollapse" aria-controls="navbarCollapse" aria-expanded="false" aria-label="Toggle navigation">
        <span class="navbar-toggler-icon"></span>
      </button>
      <div class="collapse navbar-collapse" id="navbarCollapse">
        <ul class="navbar-nav mr-auto bg-dark">
          <li class="nav-item" v-bind:class="{ active: tab=='' }">
            <a class="nav-link" @click="go('')">{{t('home')}}</a>
          </li>
          <li v-if="my_validator" class="nav-item" v-bind:class="{ active: tab=='install' }">
            <a class="nav-link" @click="go('install')">{{t('install')}}</a>
          </li>
          <li v-if="auth_code" class="nav-item" v-bind:class="{ active: tab=='wallet' }">
            <a class="nav-link" @click="go('wallet')">{{t('wallet')}}</a>
          </li>
          <li class="nav-item" v-bind:class="{ active: tab=='hubs' }">
            <a class="nav-link" @click="go('hubs')">{{t('banks')}}</a>
          </li>
          <li class="nav-item" v-bind:class="{ active: tab=='assets'}"><a class="nav-link" @click="go('assets')">{{t('assets')}}</a></li>
          <li class="nav-item" v-bind:class="{ active: tab=='exchange' }">
            <a class="nav-link" @click="go('exchange')">{{t('onchain_exchange')}}</a>
          </li>
          <li v-if="pubkey" class="nav-item" v-bind:class="{ active: tab=='settings' }">
            <a class="nav-link" @click="go('settings')">{{t('settings')}}</a>
          </li>
          <li class="nav-item dropdown">
            <a class="dropdown-toggle nav-link" data-toggle="dropdown">{{t('explorers')}}
        <span class="caret"></span></a>
            <ul class="dropdown-menu bg-dark" style="width: 300px">
              <li><a class="nav-link" @click="go('blockchain_explorer')">{{t('blockchain_history')}}</a></li>
              <li><a class="nav-link" @click="go('account_explorer')">{{t('accounts')}}</a></li>
              <li><a class="nav-link" @click="go('channel_explorer')">{{t('insurances')}}</a></li>
              <li><a class="nav-link" @click="go('validators')">{{t('validators')}}</a></li>
              <li><a class="nav-link" @click="go('bank_manager')">{{t('bank_manager')}}</a></li>
              <li><a class="nav-link" @click="go('asset_manager')">{{t('asset_manager')}}</a></li>
              <li><a class="nav-link" @click="go('updates')">{{t('smart_updates')}}</a></li>
              <li><a class="nav-link" @click="go('help')">{{t('network_info')}}</a></li>
              <li><a class="nav-link" @click="go('metrics')">{{t('node_metrics')}}</a></li>
            </ul>
          </li>
          <li class="nav-item" v-if="onServer">
            <a class="nav-link" href="https://web.fairlayer.com">{{t('web_wallet')}}</a>
          </li>
          <li class="nav-item">
            <a class="nav-link" href="https://github.com/fairlayer/wiki">{{t('docs')}}</a>
          </li>
        </ul>
        <span v-if="K.ts < ts() - K.safe_sync_delay" @click="call('sync')" v-bind:class='["badge", "badge-danger"]'>#{{K.total_blocks}}/{{K.total_blocks + Math.round((ts() - K.ts)/K.blocktime)}}, {{timeAgo(K.ts)}}</span>
        <span v-else-if="K.total_blocks" class="navbar-text">Block #{{K.total_blocks}}</span> &nbsp;
        <a v-if="onServer" href="/demoinstance">
          <button class="btn btn-success">Try Demo</button>
        </a>
        &nbsp;&nbsp;
        <span class="dotted navbar-text" @click="lang = lang == 'en' ? 'ru' : 'en'">{{lang}}</span>
      </div>
    </nav>
    <br>
    <div class="container">
      <div class="tpstrend visible-lg-4" @click="go('metrics')" v-if="my_hub">
        <trend :data="metrics.settle.avgs.slice(metrics.settle.avgs.length-300)" :gradient="['#6fa8dc', '#42b983', '#2c3e50']" auto-draw :min=0 :width=150 :height=50>
        </trend>
      </div>
      <div v-if="!online">
        <template src="./js/t.html"></template>
        <h1>Connection failed, reconnecting...</h1>
      </div>
      <div v-else-if="sync_started_at && K.ts < ts() - K.safe_sync_delay">
        <h1>Syncing and validating new blocks</h1>
        <p>Please wait for validation of all blocks that were created while your node was offline. To avoid this in the future enable background sync. Blocks synced so far: {{K.total_blocks - sync_started_at}}, tx: {{K.total_tx - sync_tx_started_at}}</p>
        <div class="progress">
          <div class="progress-bar" v-bind:style="{ width: sync_progress+'%', 'background-color':'#5cb85c'}" role="progressbar"></div>
        </div>
      </div>
      <div v-else-if="tab==''">
        <Home></Home>
      </div>
      <div v-else-if="tab=='metrics'">
        <h2>Node Metrics</h2>
        <p v-for="(obj, index) in metrics">
          <b v-if="['volume','fees'].indexOf(index) != -1">Current {{index}}/s: {{commy(obj.last_avg)}} (max {{commy(obj.max)}}, total {{commy(obj.total)}}).</b>
          <b v-else>Current {{index}}/s: {{commy(obj.last_avg,false)}} (max {{commy(obj.max,false)}}, total {{commy(obj.total,false)}}).</b>
          <trend :data="obj.avgs.slice(obj.avgs.length-300)" :gradient="['#6fa8dc', '#42b983', '#2c3e50']" auto-draw :min="0" smooth>
          </trend>
        </p>
      </div>
      <div v-else-if="tab=='validators'">
        <h1>Validators</h1>
        <table class="table">
          <thead class="thead-dark">
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Shares</th>
              <th scope="col">Platform</th>
              <th scope="col">Website</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in K.validators">
              <td>{{m.username}}</td>
              <td>{{m.shares}}</td>
              <td>{{m.platform}}</td>
              <td><a v-bind:href="m.website+'/#install'">{{m.website}}</a>
                <td>
            </tr>
          </tbody>
        </table>
        <div class="form-group">
          <h2>Become a Validator</h2>
          <p>
            <label for="comment">Identity verification:</label>
            <input class="form-control" v-model="new_validator.handle" rows="2" placeholder="newhub"></input>
          </p>
          <p>
            <label for="comment">Location (Fairlayer-compatible RPC):</label>
            <input class="form-control" v-model="new_validator.location" rows="2"></input>
          </p>
          <p v-if="record && !my_validator">
            <button class="btn btn-outline-success" @click="call('propose', {op: 'validator', location: new_validator.location})">Propose Validator</button>
          </p>
          <p v-else-if="my_validator"><b>You are already a validator.</b></p>
          <p v-else>You must have a registered account with FRD balance.</p>
          <div class="alert alert-primary">If approved this account will be marked as a validator. Do not use this account for any other purposes.</div>
        </div>
      </div>
      <div v-else-if="tab=='help'">
        <h1>Network</h1>
        <p>Blocktime: {{K.blocktime}} seconds</p>
        <p>Blocksize: {{K.blocksize}} bytes</p>
        <p>Account creation fee (pubkey registration): {{commy(K.account_creation_fee)}}</p>
        <p>Average broadcast fee: {{commy(K.min_gasprice * 83)}} (to short ID) – {{commy(K.min_gasprice * 115)}} (to pubkey)</p>
        <h2>Banks & topology</h2>
        <p>Risk limit: {{commy(K.risk)}}</p>
        <p>Hard risk limit: {{commy(K.hard_limit)}}</p>
        <h2>Snapshots</h2>
        <p>Make snapshot at blocks: {{K.snapshot_after_blocks}}</p>
        <p>Last snapshot at block # : {{K.last_snapshot_height}}</p>
        <p>Snapshots taken: {{K.snapshots_taken}}</p>
        <h2>Network stats</h2>
        <p>Total blocks: {{K.total_blocks}}</p>
        <p>Current {{onchain}} hash: {{K.current_db_hash}}</p>
        <p>Usable blocks: {{K.total_blocks}}</p>
        <p>Last block received {{timeAgo(K.ts)}}</p>
        <p>Network created {{timeAgo(K.created_at)}}</p>
        <p>Transactions: {{K.total_tx}}</p>
        <p>Total bytes: {{K.total_bytes}}</p>
        <p>Smart updates created: {{K.proposals_created}}</p>
      </div>
      <div v-else-if="tab=='settings'">

        <pre>Auth link: {{getAuthLink()}}</pre>
        <p>
          <button class="btn btn-dark" @click="dev_mode=!dev_mode">Toggle Devmode</button>
        </p>
        <p>
          <button type="button" class="btn btn-outline-danger" @click="call('logout')">Graceful Shutdown
          </button>
        </p>
        <h2>Manual Hard Fork</h2>
        <p>If validators vote for things you don't agree with, find like minded people and replace them.</p>
        <div class="form-group">
          <label for="comment">Code to execute:</label>
          <textarea class="form-control" v-model="hardfork" rows="4" id="comment"></textarea>
        </div>
        <p>
          <button @click="call('hardfork', {hardfork: hardfork})" class="btn btn-outline-danger">Execute Code</button>
        </p>
      </div>
      <div v-else-if="tab=='wallet'">
        <template v-if="pubkey">
          <h4 class="alert alert-primary" v-if="my_hub">This node is a bank: {{my_hub.handle}}</h4>
          <p class="pull-left">
            <select v-model="asset" class="custom-select custom-select-lg mb-6" @change="order.buyAssetId = (asset==1 ? 2 : 1)">
              <option disabled>Select current asset</option>
              <option v-for="a in assets" :value="a.id">{{a.name}} ({{a.ticker}})</option>
            </select>
          </p>
          <div v-if="record">
            <h4 style="display:inline-block">
              Your {{onchain}} ID: {{record.id}}
            </h4>
            <div v-for="a in PK.usedAssets">{{to_ticker(a)}}: {{commy(getAsset(a))}} <span class="badge badge-success layer-faucet" @click="call('onchainFaucet', {amount: uncommy(prompt('How much you want to get?')), asset: a })">+</span></div>
            <br>
            <p>
              <input style="width:300px" type="text" class="form-control small-input" v-model="externalDeposit.to" placeholder="Layer ID">
              </[td]>
              <p>
                <select style="width:300px" type="text" class="form-control" v-model="externalDeposit.hub">
                  <option value="onchain"> {{onchain}}</option>
                  <option v-for="hub in K.hubs" :value="hub.handle"> {{hub.handle}}</option>
                </select>
              </p>
              <p>
                <input style="width:300px" type="text" class="form-control small-input" v-model="externalDeposit.depositAmount" placeholder="Amount to deposit">
              </p>
              <p>
                <input style="width:300px" type="text" class="form-control small-input" v-model="externalDeposit.invoice" placeholder="Public Message (optional)">
              </p>
              <p>
                <button type="button" class="btn btn-outline-secondary" @click="addExternalDeposit">Transfer 🌐</button>
              </p>
          </div>
          <div v-else>
            <h4 style="display:inline-block">
              Temporary {{onchain}} ID: <small>{{pubkey}}</small> <span class="badge badge-success layer-faucet" @click="call('onchainFaucet', {amount: uncommy(prompt('How much you want to get?')), asset: 1 })">+</span>
            </h4>
          </div>
          <table v-if="events.length > 0" class="table">
            <thead>
              <tr>
                <th width="5%">Block #</th>
                <th width="65%">Details</th>
              </tr>
            </thead>
            <tbody>
              <Event v-for="ev in events" :ev="ev">
            </tbody>
          </table>
          <hr class="my-4">
          <template v-if="channels.length > 0">
            <div class="alert alert-info" v-for="ch in channels">
            
              <h2>
                {{K.hubs.find(h=>h.pubkey==ch.d.partnerId).handle }}
              </h2>

              <template v-for="subch in ch.d.subchannels">
                <button class="btn btn-outline-info" @click="mod={shown:true, ch:ch, subch: subch, hard_limit: subch.hard_limit, soft_limit: subch.soft_limit}">{{to_ticker(subch.asset)}}: {{commy(ch.derived[subch.asset].payable)}}</button>&nbsp;  
              </template>

              <hr>

              <template v-if="record">
                <span v-if="ch.ins.dispute_delayed">
                  <b>{{ch.ins.dispute_delayed - K.usable_blocks}} usable blocks</b> left until dispute resolution <dotsloader></dotsloader>
                </span>
                <span v-else-if="ch.d.status=='dispute'">
                  Wait until your dispute tx is broadcasted
                </span>
                <button v-else type="button" class="btn btn-danger" @click="call('startDispute', {partnerId: ch.d.partnerId})">Start Dispute 🌐</button>
              </template>



  
            </div>





            <p style="word-wrap: break-word">Your Address: <b>{{address}}</b></p>
            <div class="col-sm-6" style="width:300px">
              <p>
                <div class="input-group" style="width:300px">
                  <input type="text" class="form-control small-input" v-model="outward_address" :disabled="['none','amount'].includes(outward_editable)" placeholder="Address" aria-describedby="basic-addon2" @input="updateRoutes">
                </div>
              </p>
              <p>
                <div class="input-group" style="width:300px">
                  <input type="text" class="form-control small-input" v-model="outward_amount" :disabled="outward_editable=='none'" placeholder="Amount" aria-describedby="basic-addon2" @input="updateRoutes">
                </div>
              </p>
              <p>
                <div class="input-group" style="width:300px">
                  <input type="text" class="form-control small-input" v-model="outward_invoice" :disabled="['none','amount'].includes(outward_editable)" placeholder="Private Message (optional)" aria-describedby="basic-addon2">
                </div>
              </p>
            </div>
            <template v-if="outward_address.length > 0">
              <p v-if="bestRoutes.length == 0">
                No route found for this payment.
              </p>
              <template v-else>
                <h5>Choose route/fee:</h5>
                <div class="radio" v-for="(r, index) in bestRoutes.slice(0, bestRoutesLimit)">
                  <label>
                    <input type="radio" :value="index" v-model="chosenRoute"> {{commy(uncommy(outward_amount) * r[0], true, false)}} ({{bpsToPercent(r[0]*10000)}}) <b>You</b> → {{routeToText(r)}} <b>Destination</b></label>
                </div>
                <p v-if="bestRoutes.length > bestRoutesLimit"><a class="dotted" @click="bestRoutesLimit += 5">Show More Routes</a></p>
              </template>
            </template>
            <p>
              <button type="button" class="btn btn-outline-success" @click="call('sendOffchain', {address: outward_address, asset: asset, amount: uncommy(outward_amount), invoice: outward_invoice, addrisk: addrisk, lazy: lazy, chosenRoute: bestRoutes[chosenRoute][1]})">Pay Now → </button>
              <button v-if="dev_mode" type="button" class="btn btn-outline-danger" @click="stream()">Pay 100 times</button>
            </p>
            <table v-if="payments.length > 0" class="table">
              <thead>
                <tr>
                  <th width="5%">Status</th>
                  <th width="10%">Amount</th>
                  <th width="10%">Bank</th>
                  <th width="65%">Details</th>
                  <th width="20%">Date</th>
                </tr>
              </thead>
              <transition-group name="list" tag="tbody">
                <tr v-bind:key="h.id" v-for="(h, index) in payments.slice(0, history_limit)">
                  <td v-bind:title="h.id+h.type+h.status">{{payment_status(h)}}</td>
                  <td>{{commy(h.is_inward ? h.amount : -h.amount)}}</td>
                  <td>{{h.channelId}}</td>
                  <td @click="outward_address=h.is_inward ? h.source_address : h.destination_address; outward_amount=commy(h.amount); outward_invoice = h.invoice"><u class="dotted">{{paymentToDetails(h)}}</u>: {{h.invoice}}</td>
                  <td v-html="skipDate(h, index)"></td>
                </tr>
              </transition-group>
              <tr v-if="payments.length > history_limit">
                <td colspan="7" align="center"><a @click="history_limit += 20">Show More</a></td>
              </tr>
            </table>
          </template>
          <template v-else>
            <h3 class="alert alert-info"><a class="dotted" @click=go('hubs')>Add banks</a> to send & receive payments instantly.</h3>
          </template>
        </template>
        <form v-else class="form-signin" v-on:submit.prevent="call('login',{username, pw})">
          <p>
            <h4 class="danger danger-primary">To start using Fairlayer you must create your own digital identity. Make sure you don't forget your password - <b>password recovery is not possible.</b> If in doubt, write it down or email it to yourself.</h4></p>
          <label for="inputUsername" class="sr-only">Username</label>
          <input v-model="username" type="text" id="inputUsername" class="form-control" placeholder="Username" required autofocus>
          <br>
          <label for="inputPassword" class="sr-only">Password</label>
          <input v-model="pw" type="password" id="inputPassword" class="form-control" placeholder="Password" required>
          <button class="btn btn-lg btn-outline-primary btn-block step-login" id="login" type="submit">Generate Wallet</button>
        </form>
      </div>
      <div v-else-if="tab=='hubs'">
        <p>Banks inside Fairlayer are provably-solvent by design. Your device always stores a cryptographic dispute proof in case you need to get your assets back. Choose your banks based on people and businesses you transact with, your location and their track record. If a bank is compromised you may lose your uninsured balance, so don't forget to request insurance.</p>


        <template v-for="u in K.hubs">
          <h1>{{u.handle}}</h1>
          <!--<img v-bind:src="'/img/icons/' + u.id +'.jpg'">-->

          <small>Created at {{new Date(u.createdAt*1000).toDateString()}}</small>

          <p>Fees: {{bpsToPercent(u.fee_bps)}}</p>
          <small><a :href="u.website">{{u.website}}</a></small>

          <p v-if="PK">
            <button v-if="PK.usedHubs.includes(u.id)" class="btn btn-outline-danger" @click="call('toggleHub', {id: u.id})">Close Account</button>
            <button v-else-if="my_hub && my_hub.id==u.id" class="btn btn-outline-success">It's you</button>
            <button v-else class="btn btn-outline-success" @click="call('toggleHub', {id: u.id})">Open an Account</button>
          </p>
        </template>

      </div>
      <div v-else-if="tab=='asset_manager'">
<div class="form-group">
          <h2>Create an Asset</h2>
          <p>
            <label for="comment">Name:</label>
            <input class="form-control" v-model="new_asset.name" rows="2" id="comment"></input>
          </p>
          <p>
            <label for="comment">Ticker (must be unique):</label>
            <input class="form-control" v-model="new_asset.ticker" rows="2" id="comment"></input>
          </p>
          <p>
            <label for="comment">Amount:</label>
            <input class="form-control" v-model="new_asset.amount" rows="2" id="comment"></input>
          </p>
          <p>
            <label for="comment">Division point (e.g. 0 for yen, 2 for dollar):</label>
            <input class="form-control" v-model="new_asset.division" rows="2" id="comment"></input>
          </p>
          <p>
            <label for="comment">Description:</label>
            <input class="form-control" v-model="new_asset.desc" rows="2" id="comment"></input>
          </p>
          <p v-if="record">
            <button class="btn btn-outline-success" @click="call('createAsset', new_asset)">Create Asset 🌐</button>
          </p>
          <p v-else>In order to create your own asset you must have a registered account with FRD balance.</p>
          <div class="alert alert-primary">After creation the entire supply will appear on your {{onchain}} balance, then you can deposit it to a bank and start sending instantly to other users.</div>
        </div>
      </div>
      <div v-else-if="tab=='bank_manager'">

        <div class="form-group">
          <h2>Create a Bank</h2>
          <p>
            <label for="comment">Handle:</label>
            <input class="form-control" v-model="new_hub.handle" rows="2" placeholder="newhub"></input>
          </p>
          <p>
            <label for="comment">Fee (in basis points, 10 is 0.10%):</label>
            <input class="form-control" v-model="new_hub.fee_bps" rows="2" id="comment"></input>
          </p>
          <p>
            <label for="comment">Fairlayer-compatible RPC:</label>
            <input class="form-control" v-model="new_hub.location" rows="2"></input>
          </p>
          <p>
            <label for="comment">Routes to add (their bank id, route agreement in hex):</label>
            <input class="form-control" v-model="new_hub.add_routes" rows="2"></input>
          </p>
          <p>
            <label for="comment">Routes to remove (comma separated ids):</label>
            <input class="form-control" v-model="new_hub.remove_routes" rows="2"></input>
          </p>
          <p v-if="record && !my_hub">
            <button class="btn btn-outline-success" @click="call('createHub', new_hub)">Create Bank 🌐</button>
          </p>
          <p v-else-if="my_hub"><b>You are already a bank.</b></p>
          <p v-else>In order to create your own asset you must have a registered account with FRD balance.</p>
          <div class="alert alert-primary">After execution this account will be marked as a bank. Do not use this account for any other purposes.</div>
        </div>
        <svg width="800" height="600" id="hubgraph"></svg>
      </div>
      <div v-else-if="tab=='exchange'">
        <h3>Trustless {{onchain}} Exchange</h3>
        <p>{{onchain}} exchange is best suitable for large atomic swaps between two assets - it always incurs an expensive fees but is free of any counterparty risk. If you're looking to trade frequently or small amounts, try any traditional exchange that supports Fair assets.</p>
        <p>Amount of {{to_ticker(asset)}} you want to sell (you have {{commy(getAsset(asset))}}):</p>
        <p>
          <input style="width:300px" class="form-control small-input" v-model="order.amount" placeholder="Amount to sell" @input="estimate(false)">
        </p>
        <p>Asset you are buying (you have {{commy(getAsset(order.buyAssetId))}}):</p>
        <p>
          <select v-model="order.buyAssetId" class="custom-select custom-select-lg lg-3">
            <option v-for="(a,index) in assets" v-if="a.id!=asset" :value="a.id">{{a.name}} ({{a.ticker}})</option>
          </select>
        </p>
        <p>Rate {{[asset, order.buyAssetId].sort().reverse().map(to_ticker).join('/')}}:</p>
        <p>
          <input style="width:300px" class="form-control small-input" v-model="order.rate" placeholder="Rate" @input="estimate(false)">
        </p>
        <p>{{to_ticker(order.buyAssetId)}} you will get:</p>
        <p>
          <input style="width:300px" class="form-control small-input" v-model="order.buyAmount" @input="estimate(true)">
        </p>
        <div v-if="![asset, order.buyAssetId].includes(1)" class="alert alert-danger">You are trading pair without FRD, beware of small orderbook and lower liquidity in direct pairs.</div>
        <p v-if="pubkey && record && getAsset(1) > 200">
          <button type="button" class="btn btn-warning" @click="call('createOrder', {order: order, asset: asset})">Create Order 🌐</button>
        </p>
        <p v-else>In order to trade you must have a registered account with FRD in {{onchain}}.</p>
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
                <td>{{to_user(b.userId)}}</td>
                <td>{{to_ticker(b.assetId)}}</td>
                <td>{{[b.assetId, b.buyAssetId].sort().reverse().map(to_ticker).join('/')}}</td>
                <td>{{commy(b.amount)}}</td>
                <td>{{b.rate.toFixed(6)}}</td>
                <td v-if="record && record.id == b.userId">
                  <button @click="call('cancelOrder', {id: b.id})" class="btn btn-outline-success">Cancel</button>
                </td>
                <td v-else>
                  <button class="btn btn-outline-success" @click="order.amount = buyAmount(b); order.rate = b.rate; order.buyAssetId=b.assetId; asset = b.buyAssetId; estimate(false)">Fulfill</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <div v-else-if="tab=='install'">
        <h4>Web Wallet (optimized for convenience)</h4>
        <p>If you are on mobile or want to store only small amounts you can use a <a href="https://web.fairlayer.com">custodian web wallet</a></p>
        <h4>Instant Web Demo</h4>
        <p><a href="/demoinstance">Try Fair Core for 1 hour without installing it on your computer.</a> Currently active sessions: {{busyPorts}}</p>
        <h4>Fair Core (optimized for security)</h4>
        <p>Install <a href="https://nodejs.org/en/download/">Node.js</a> (9.6.0+) and copy paste this snippet into your Terminal app and press Enter:</p>
        <div style="background-color: #FFFDDE; padding-left: 10px;">
          <Highlight :white="true" lang="bash" :code="install_snippet"></Highlight>
        </div>
        <p><b>For higher security</b> visit a few trusted nodes below and verify the snippet to ensure our server isn't compromised. Only paste the snippet into Terminal if there is exact match with other sources.</p>
        <ul>
          <li v-for="m in K.validators" v-if="m.website && (!my_validator || m.id != my_validator.id)"><a v-bind:href="m.website+'/#install'">{{m.website}} - by {{m.username}} ({{m.platform}})</a></li>
        </ul>
      </div>
      <div v-else-if="tab=='updates'">
        <h3>Smart Updates</h3>
        <p>Smart updates solve the same problem as smart contracts - they are adding a new functionality into the blockchain. While smart contracts run inside a complicated virtual machine with execution overhead and opcode limitations, smart updates modify the underlying blockchain software and provide a more effective and powerful way to add a new feature or fix a problem. Anyone can propose a smart update, validators vote for it and then it is syncroniously applied across all nodes.</p>
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
        <p>
          <button @click="call('propose', proposal)" class="btn btn-warning">Propose 🌐</button>
        </p>
        <div v-for="p in proposals">
          <h4>#{{p.id}}: {{p.desc}}</h4>
          <small>Proposed by {{to_user(p.user.id)}}</small>
          <UserIcon :hash="p.user.pubkey" :size="30"></UserIcon>
          <Highlight lang="javascript" :code="p.code"></Highlight>
          <div v-if="p.patch">
            <div style="line-height:15px; font-size:12px;">
              <Highlight lang="diff" :code="p.patch"></Highlight>
            </div>
          </div>
          <p v-for="u in p.voters">
            <UserIcon :hash="u.pubkey" :size="30"></UserIcon>
            <b>{{u.vote.approval ? 'Approved' : 'Denied'}}</b> by {{to_user(u.id)}}: {{u.vote.rationale ? u.vote.rationale : '(no rationale)'}}
          </p>
          <small>To be executed at {{p.delayed}} usable block</small>
          <div v-if="record">
            <p v-if="!ivoted(p.voters)">
              <button @click="call('vote', {approval: 1, id: p.id})" class="btn btn-outline-success">Approve 🌐</button>
              <button @click="call('vote', {approval: 0, id: p.id})" class="btn btn-outline-danger">Deny 🌐</button>
            </p>
          </div>
        </div>
      </div>
      <div v-else-if="tab=='blockchain_explorer'">
        <h1>Blockchain Explorer</h1>
        <p>These transactions were publicly broadcasted and executed on every full node, including yours. Blockchain space is reserved for insurance rebalances, disputes and other high-level settlement actions.</p>
        <p v-if="nextValidator">Next validator: {{to_user(nextValidator.id)}}</p>
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
                <td>{{b.built_by}} ({{new Date(b.timestamp*1000)}})</td>
                <td>{{b.total_tx}}</td>
              </tr>
              <tr v-for="batch in (b.meta && b.meta.parsed_tx)">
                <td colspan="7">
                  <span class="badge badge-warning">By {{to_user(batch.signer.id)}} ({{batch.gas}}*{{commy(batch.gasprice, true, false)}}={{commy(batch.txfee)}} fee):</span>&nbsp;
                  <template v-for="d in batch.events">
                    &nbsp;
                    <span v-if="d[0]=='disputeWith'" class="badge badge-primary" v-html="dispute_outcome(d[2], d[3], d[4])">
                    </span>
                    <span v-else-if="d[0]=='setAsset'" class="badge badge-dark">{{d[1]}} {{to_ticker(d[2])}}</span>
                    <span v-else-if="d[0]=='withdrawFrom'" class="badge badge-danger">{{commy(d[1])}} from {{to_user(d[2])}}</span>
                    <span v-else-if="d[0]=='revealSecrets'" class="badge badge-danger">Reveal: {{trim(d[1])}}</span>
                    <span v-else-if="d[0]=='enforceDebt'" class="badge badge-dark">{{commy(d[1])}} debt to {{to_user(d[2])}}</span>
                    <span v-else-if="d[0]=='depositTo'" class="badge badge-success">{{commy(d[1])}} to {{d[3] ? ((d[2] == batch.signer.id ? '': to_user(d[2]))+'@'+to_user(d[3])) : to_user(d[2])}}{{d[4] ? ' for '+d[4] : ''}}</span>
                    <span v-else-if="d[0]=='createOrder'" class="badge badge-dark">Created order {{commy(d[2])}} {{to_ticker(d[1])}} for {{to_ticker(d[3])}}</span>
                    <span v-else-if="d[0]=='cancelOrder'" class="badge badge-dark">Cancelled order {{d[1]}}</span>
                    <span v-else-if="d[0]=='createAsset'" class="badge badge-dark">Created {{commy(d[2])}} of asset {{d[1]}}</span>
                    <span v-else-if="d[0]=='createHub'" class="badge badge-dark">Created bank {{d[1]}}</span>
                  </template>
                </td>
              </tr>
              <tr v-if="b.meta">
                <td v-if="b.meta.cron.length + b.meta.missed_validators.length > 0" colspan="7">
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
          <p><b>This node does not keep blocks. <a href="https://fairlayer.com/#blockchain_explorer">Try public explorer.</a></b></p>
        </div>
      </div>
      <div v-else-if="tab=='account_explorer'">
        <h1>Account Explorer</h1>
        <p>This is a table of registered users in the network. {{onchain}} balance is normally used to pay transaction fees, and most assets are stored with banks under Insurance explorer.</p>
        <table class="table table-striped">
          <thead class="thead-dark">
            <tr>
              <th scope="col">Icon</th>
              <th scope="col">ID</th>
              <th scope="col">Name</th>
              <th scope="col">Pubkey</th>
              <th scope="col">Assets</th>
              <th scope="col">Batch Nonce</th>
              <th scope="col">Debts</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users">
              <th>
                <UserIcon :hash="u.pubkey" :size="30"></UserIcon>
              </th>
              <th scope="row">{{to_user(u.id)}}</th>
              <td>{{u.username}}</td>
              <td><small>{{u.pubkey.substr(0,10)}}..</small></td>
              <td><span v-for="b in u.balances">{{to_ticker(b.asset)}}: {{commy(b.balance)}}</span></td>
              <td>{{u.batch_nonce}}</td>
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
              <th scope="col">Insurances</th>
              <th scope="col">Withdrawal Nonce</th>
              <th scope="col">Dispute</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="ins in insurances">
              <th v-html="to_user(ins.leftId)"></th>
              <th v-html="to_user(ins.rightId)"></th>
              <th><span v-for="subins in ins.subinsurances">{{to_ticker(subins.asset)}}: {{commy(subins.balance)}}</span></th>
              <th>{{ins.withdrawal_nonce}}</th>
              <th>{{ins.dispute_delayed ? "Until "+ins.dispute_delayed+" started by "+(ins.dispute_left ? 'Left' : 'Right') : "No" }}</th>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else-if="tab=='assets'">
        <h1>Assets</h1>
        <p>Fair assets is the name for all kinds of fiat/crypto-currencies, tokens and stock you can create on top of the system.</p>
        <table class="table table-striped">
          <thead class="thead-dark">
            <tr>
              <th scope="col">Ticker</th>
              <th scope="col">Name</th>
              <th scope="col">Description</th>
              <th scope="col">Total Supply</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in assets">
              <th>{{u.ticker}}</th>
              <th>{{u.name}}</th>
              <th>{{u.desc}}</th>
              <th>{{commy(u.total_supply)}}</th>
              <th v-if="PK">
                <button v-if="PK.usedAssets.includes(u.id)" class="btn btn-outline-danger" @click="call('toggleAsset', {id: u.id})">Remove</button>
                <button v-else class="btn btn-outline-success" @click="call('toggleAsset', {id: u.id})">Add</button>
              </th>
            </tr>
          </tbody>
        </table>
        
      </div>
    </div>


<div v-if="mod.shown" class="modal-backdrop fade show"></div>
<div @click.self="mod.shown=false"  class="modal fade bd-example-modal-lg" v-if="mod.shown"  v-bind:style="{display: mod.shown ? 'block' : 'none'}" v-bind:class="{show: mod.shown}" >
  <div style="min-width:70%;" class="modal-dialog modal-lg" role="document">
    <div class="modal-content">
      <div class="modal-header">
        <h5 class="modal-title">Asset {{to_ticker(mod.subch.asset)}} in bank {{to_user(mod.ch.partner)}}</h5>
        <button  @click="mod.shown=false"  type="button" class="close" data-dismiss="modal" aria-label="Close">
          <span aria-hidden="true">&times;</span>
        </button>
      </div>
      <div class="modal-body">
  <div class="container-fluid">
    <div class="row">
      <div class="col-md-6">
        <h4>Information</h4>

        <p>Payable: {{commy(derived.payable)}} <span class="badge badge-success bank-faucet" @click="call('withChannel', {partnerId: mod.ch.d.partnerId, op: 'testnet', action: 'faucet', asset: mod.subch.asset, amount: uncommy(prompt('How much you want to get?')) })">Use faucet</span></p>
        <p>Receivable: {{commy(derived.they_payable)}}</p>
        <p>Insured: {{commy(derived.insured)}}        <span class="badge badge-danger" @click="a=prompt(`How much to withdraw to onchain?`);if (a) {call('withChannel', {partnerId: mod.ch.d.partnerId, asset: mod.subch.asset, op: 'withdraw', amount: uncommy(a)})};">Withdraw to {{onchain}}</span>
</p>
        <p>Uninsured: {{commy(derived.uninsured)}} <span class="badge badge-danger" @click="requestInsurance(mod.ch, mod.subch.asset)">Request Insurance</span>
                      <dotsloader v-if="derived.subch.requested_insurance"></dotsloader></p>

        </div>
      <div class="col-md-6">

            <h4>Credit limits</h4>
            <p>Maximum uninsured balance</p>
            <p>
              <input type="text" class="form-control" v-model="mod.hard_limit">
            </p>
            <p>Automatically request insurance after</p>
            <p>
              <input type="text" class="form-control" v-model="mod.soft_limit">
            </p>
            <p>
              <button type="button" class="btn btn-outline-success" @click="call('withChannel', {partnerId: mod.ch.d.partnerId, asset: mod.subch.asset, op: 'setLimits', hard_limit: uncommy(mod.hard_limit), soft_limit: uncommy(mod.soft_limit)})" href="#">Update Credit Limits</button>
            </p>
            </div>


                </div>
  </div>


      </div>
      <div class="modal-footer">
        <button @click="mod.shown=false" type="button" class="btn btn-secondary" data-dismiss="modal">Close</button>
      </div>
    </div>
  </div>
</div>
  </div>


</template>

<script>
import UserIcon from './UserIcon'
import Highlight from './Highlight'
import Home from './Home'
import Tutorial from './Tutorial'
import Event from './Event'

import Dotsloader from './Dotsloader'


export default {
  components: {
    UserIcon,
    Highlight,
    Home,
    Tutorial,
    Event,
    Dotsloader
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
      onchain: 'Layer',

      online: true,

      lang: 'en',


      onServer: location.hostname == 'fairlayer.com',
      auth_code: localStorage.auth_code,

      asset: hashargs['asset'] ? parseInt(hashargs['asset']) : 1,

      bestRoutes: [],


      bestRoutesLimit: 5,

      chosenRoute: 0,

      gasprice: 1,
      events: [],

      assets: [],
      orders: [],
      channels: [],
      payments: [],
      insurances: [],

      batch: [],
      busyPorts: 0,


      new_validator: {
        handle: "Name",
        location: `ws://${location.hostname}:${parseInt(location.port)+100}`
      },



      new_asset: {
        name: 'Yen ¥',
        ticker: 'YEN',
        amount: 100000000000,
        desc: 'This asset represents Japanese Yen and is backed by the Bank of Japan.'
      },


      new_hub: {
        handle: "BestBank",
        location: `ws://${location.hostname}:${parseInt(location.port)+100}`,
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


      mod: {
        shown: false,
        subch: {},
        ch: {},
        soft_limit: '',
        hard_limit: ''
      },

      expandedChannel: -1,

      externalDeposit: {
        to: '',
        hub: 'onchain',
        depositAmount: '',
        invoice: '',
        asset: 1
      },

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
      visibleGraph: false,

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
  derived: function(){
    let ch = this.channels.find(ch=>ch.d.id == this.mod.ch.d.id)

    return ch.derived[this.mod.subch.asset]
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

    updateRoutes: () => {
      if (app.outward_address.length < 4) return

      // address or amount was changed - recalculate best offered routes
      app.call('getRoutes', {
        address: app.outward_address,
        amount: app.uncommy(app.outward_amount),
        asset: app.asset
      })
    },

    routeToText: (r) => {
      let info = "";

      for (let hop of r[1]) {
        let hub = app.K.hubs.find(h => h.id == hop);
        if (hub) {
          //(${app.bpsToPercent(hub.fee_bps)})
          info += `@${app.to_user(hub.id)} → `;
        }
      }

      return info
    },

    bpsToPercent: (p) => {
      return app.commy(p, true, false) + "%";
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



    toHexString: (byteArray) => {
      return Array.prototype.map
        .call(byteArray, function(byte) {
          return ('0' + (byte & 0xff).toString(16)).slice(-2)
        })
        .join('')
    },

    requestInsurance: (ch, asset) => {
      if (!app.record && asset != 1) {
        alert(`You can't have insurance in non-FRD assets now, ${app.onchain} registration is required. Request insurance in FRD asset first.`)
        return
      }

      if (confirm(app.record ? `Increasing insurance in ${app.onchain} costs a fee, continue?` : `You will be charged ${app.commy(app.K.account_creation_fee)} for registration, and ${app.commy(app.K.standalone_balance)} will be sent to your ${app.onchain} account. Continue?`)) {
        app.call('withChannel', { partnerId: ch.d.partnerId, op: 'requestInsurance', asset: asset })
      }
    },



    call: function(method, args = {}) {
      if (method == 'vote') {
        args.rationale = prompt('Why?')
        if (!args.rationale) return false
      }


      FS(method, args).then(render)
      return false
    },






    addExternalDeposit: () => {
      let d = app.externalDeposit
      app.call('externalDeposit', {
        asset: app.asset,
        depositAmount: app.uncommy(d.depositAmount),
        hub: d.hub,
        to: d.to,
        invoice: d.invoice
      })

      // reset all formfields
      app.externalDeposit = { hub: 'onchain' }
    },



    estimate: (f) => {
      if (f) {
        app.order.rate = (app.asset > app.order.buyAssetId ? app.order.buyAmount / app.order.amount : app.order.amount / app.order.buyAmount).toFixed(6)
      } else {
        app.order.buyAmount = (app.asset > app.order.buyAssetId ? app.order.amount * app.order.rate : app.order.amount / app.order.rate).toFixed(6)
      }
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
      // returns either bank name or just id
      // todo: twitter-style tooltips with info on the user

      let h = app.K.hubs.find((h) => h.id == userId)
        //`<span class="badge badge-success">@${h.handle}</span>`
      return h ? h.handle : userId
    },

    getAsset: (asset, user) => {
      if (!user) user = app.record
      if (!user) return 0

      let b = user.balances.find(b => b.asset == asset)

      if (b) {
        return b.balance
      } else {
        return 0
      }
    },


    showGraph: () => {

      if (!window.hubgraph) return

      drawHubgraph({
        nodes: app.K.hubs.map((h) => {
          return { id: h.id, handle: h.handle, group: 1 }
        }),
        links: app.K.routes.map((r) => {
          return { source: r[0], target: r[1], value: 1 }
        })
      })
    },



    go: (path) => {
      var authed = ['wallet', 'transfer', 'onchain', 'testnet']

      //if (authed.includes(path) && !localStorage.auth_code) path = ''


      if (path == '') {
        history.pushState('/', null, '/')
      } else {
        location.hash = '#' + path
      }

      app.tab = path



    },

    paymentToDetails: (h) => {
      let ch = app.channels.find(ch => {
        return ch.d.id == h.channelId
      })
      if (!ch) return 'no'


      if (h.is_inward) {
        return `From ${h.source_address ? app.trim(h.source_address) : 'N/A'}`
      } else {
        return `To ${h.destination_address ? app.trim(h.destination_address) : 'N/A'}`
      }
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

    commy: (b, asset = 1) => {
      var dot = true
      var withSymbol = '$'

      if (asset == 2) {
        withSymbol = '€'
      }

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

      if (withSymbol) {
        prefix = prefix + withSymbol
      }

      return prefix + b.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    },
    uncommy: (str) => {
      if (str == '' || !str) return 0
        //if (str.indexOf('.') == -1) str += '.00'

      // commas are removed as they are just separators 
      str = str.replace(/,/g, '')

      return Math.round(parseFloat(str) * 100)

      //parseInt(str.replace(/[^0-9]/g, ''))
    },

    timeAgo: (time) => {
      var units = [{
        name: 'second',
        limit: 60,
        in_seconds: 1
      }, {
        name: 'minute',
        limit: 3600,
        in_seconds: 60
      }, {
        name: 'hour',
        limit: 86400,
        in_seconds: 3600
      }, {
        name: 'day',
        limit: 604800,
        in_seconds: 86400
      }, {
        name: 'week',
        limit: 2629743,
        in_seconds: 604800
      }, {
        name: 'month',
        limit: 31556926,
        in_seconds: 2629743
      }, {
        name: 'year',
        limit: null,
        in_seconds: 31556926
      }]
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

    t: window.t,

    toggle: () => {
      if (localStorage.settings) {
        delete localStorage.settings
      } else {
        localStorage.settings = 1
      }

      app.settings = !app.settings
    },

    ts: () => Math.round(new Date() / 1000),


    prettyBatch: (batch) => {
      let r = ''
      for (let tx of batch) {
        if (['withdrawFrom', 'depositTo'].includes(tx[0])) {

          r += `<span class="badge badge-danger">${tx[1][1].length} ${tx[0]} (in ${app.to_ticker(tx[1][0])})</span>&nbsp;`

        } else {
          r += `<span class="badge badge-danger">${tx[0]}</span>&nbsp;`
        }

      }
      return r
    },

    prompt: (a) => {
      return window.prompt(a)
    },

    getAuthLink: ()=>{
      return location.origin +'#auth_code='+app.auth_code
    },



    trim: (str) => {
      return str ? str.slice(0, 8) + '...' : ''
    },
    payment_status: (t) => {
      var s = ''
      if (t.type == 'del' || t.type == 'delrisk') {
        //outcomeSecret
        s = t.outcome_type == 'outcomeSecret' ? '✔' : '❌'
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
