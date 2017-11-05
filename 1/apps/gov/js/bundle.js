(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){

module.exports = {
  timestamp: ()=>{
    return Math.floor(new Date/1000)
  }
}
},{}],2:[function(require,module,exports){
var scryptOpts = [18, 1]

var util = require('../../lib')

Hub = {
  id: 'O9gbUn1ZQ2CbDlJ3sakUfauEGv5rpVPQoFq1z/+ANAY=',
  base_fee: 100, //1 bit
  fee: 1000, //1 permille
  gold_ratio_max: 50, //ratio is currently limited at 50%
  api: 'http://l:3003/api',
  funding_depth: 1, //# confirmations
  chain_hash: '...' //btc genesis hash
}


nonce = 0

function save() {
  localStorage.profile = JSON.stringify(ProfileRecord)
}
function load(){
  ProfileRecord = JSON.parse(localStorage.profile)

  // P has derived helpers but not stored in localstorage
  P = ProfileRecord

  P.id_pair = nacl.sign.keyPair.fromSeed(Bdec( hmac(P.root, 'my_id') ))
  P.id = Benc(P.id_pair.publicKey)

  P.goldAddress = hmac(P.root, 'btc_gold')

}

function call(method, params, cb){
  var request = {
    method: method,
    //ts: timestamp(),
    to: Hub.id
  }

  if(method == 'pull'){
    // pull is not state changing, no need to increment nonce or send state
    
  }else{
    request.params = params
    request.nonce = ProfileRecord.nonce++
    save()
    //state changing
  }
  var body = JSON.stringify(request)


  var signature = sign(body, Benc(P.id_pair.secretKey))

  var x = new XMLHttpRequest()
  x.open('POST', Hub.api)

  // we avoid CORS limits
  // Quote: A header is said to be a simple header if the header field name is an ASCII case-insensitive match for Accept, Accept-Language, or Content-Language 
  x.setRequestHeader('Accept', P.id+'.'+signature )
  x.onreadystatechange = function(){
    if(x.readyState == 4){

      // Verify hub signature
      keys = x.getResponseHeader('accept').split('.')
      if(keys[0] == Hub.id && nacl.sign.detached.verify(Udec(x.response), Bdec(keys[1]), Bdec(keys[0]))){
        var response = JSON.parse(x.response)
        
        console.log(response)

        if(response.error){
          // global error handling
          alert(response.error)
        }else{
          cb(response)
        }
      }


    }
  }

  x.send(body)

}


function main() {
  load()

  myid.innerHTML = P.id

  if(P.investAddress){
    investaddr.innerHTML = P.investAddress
  }else{
    call('init', {
      goldAddress: P.goldAddress, 
      email: P.email
    }, r=>{
      P.investAddress = r.investAddress

    })
  }


  screen('list')
  show('.main-form')
}



function allclick (mask, listener) {
  var elements = document.querySelectorAll(mask)
  for (var i = 0; i < elements.length; i++) {
    elements[i].addEventListener('click', listener)
  }
}



function derive (password, email, cb) {
  var opts = {
    N: Math.pow(2, scryptOpts[0]),
    interruptStep: 1000,
    p: scryptOpts[1],
    r: 8,
    dkLen: 32,
    encoding: 'base64'
  }

  if (email === 'smoke@test.test') {
    opts.p = 1
    opts.N = 4
  }

  if (window.E) {
    try {
      window.npm_scrypt = nodeRequire('scrypt')
    } catch (e) {}
  }

  if (window.npm_scrypt) {
    window.npm_scrypt.hash(password, opts, 32, email).then(function (root) {
      cb(root.toString('base64'))
    })
  } else if (email !== 'scryptjs@test.test' && window.plugins && window.plugins.scrypt) {
    // Sometimes we want to make sure native plugin is faster
    window.plugins.scrypt(function (root) {
      cb(hexToBase64(root))
    }, alert, password, email, opts)
  } else {
    scryptjs(password, email, opts, cb)
  }
}

function hexToBase64 (hexstring) {
  return btoa(hexstring.match(/\w{2}/g).map(function (a) {
    return String.fromCharCode(parseInt(a, 16))
  }).join(''))
}

function checksum (str) {
  return Benc(nacl.hash(Udec(str))).substr(0, 2)
}

function status (msg) {
  var p = document.createElement('p')
  p.innerHTML = msg
  $('.status').appendChild(p)
}


window.onload = function () {

  $('.real-sign-in').onclick = function generation () {
    var errors = ''
    var password = $('#password').value
    var email = $('#login').value.toLowerCase()
    var emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/

    if (!emailRegex.test(email)) {
      errors += 'Invalid email. '
    }

    if (password.length < 8) {
      errors += 'Password must be at least 8 characters. '
    }

    if (errors.length > 0) {
      alert(errors)
      return false
    }

    $('#password').value = ''

    screen('generation')

    show('.step1')
    hide('.step2')

    setTimeout(function () {
      var startDerive = new Date()
      derive(password, email, function(root){

        ProfileRecord = {
          email: email,
          root: root,
          checksum: checksum(password),
          nonce: 0,
          state: {
            balance: 0
          }
        }

        hide($('.step1'))
        show($('.step2'))

        $('.accept-rules').onclick = function () {
          hide('.step2')
          save()
          main()
        }

      })


    }, 50)
  }

  $('#password').onkeypress = function (e) {
    if (e.which === 13) {
      e.preventDefault()
      $('.real-sign-in').click()
    }
  }

  allclick('.back', main)

  $('.logoutprofile').onclick = logout

  if(localStorage.profile){
    load()
    hide('.login-form')
    main()
  }else{
    show('.login-form')
  }

  derive('password','smoke@test.test', function (smoketest) {
    if(smoketest !== 'm96n+NWlQB5oRLJQjfy0jzHLmKrhuYXNcWQyesyMnwA='){
      document.write("This platform is not supported, please contact info@sakurity.com with details about your device")
    }
  })
  
}














},{"../../lib":1}]},{},[2]);
