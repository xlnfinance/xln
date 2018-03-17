// Currently not used
// FAR future: blockchain-based DNS 
var protocol = require('./protocol')
var server = require('dgram').createSocket('udp6')
var named = require('node-named')

server.on('message', function (buffer, rinfo) {
  var d = protocol.decode(buffer, 'queryMessage')
  var name = d.val.question.name
  console.log('requesting ' + name + ' server got from ' + rinfo.address + ':' + rinfo.port)
  if (name.endsWith('.fs')) {
    d.val.header.flags.qr = 1
    d.val.header.anCount = 1

    console.log(d)
    var encoded = protocol.encode({
      header: d.val.header,
      question: d.val.question,
      answers: [{
        name: name,
        rtype: 1,
        rclass: 1,
        rttl: 3600,
        rdata: new named.ARecord('127.0.0.1')
      }]
    }, 'answerMessage')
    server.send(encoded, 0, encoded.length, rinfo.port, rinfo.address, function (err, bytes) {
      console.log(err, bytes)
    })
  }
})
// need sudo
// server.bind(53, '127.0.0.1');
server.bind(53)

/*
var protocol = require('./protocol');
var DNSserver = require('dgram').createSocket('udp4');
DNSserver.on('message', function(buffer, rinfo) {
  var d = protocol.decode(buffer, 'queryMessage')
  var name = d.val.question.name
  var qtype = d.val.question.type

console.log(name)

  if(name.endsWith('.we') && (qtype == 1 || qtype == 28)){
    d.val.header.flags.qr=1
    d.val.header.anCount=1
//target: '::1', _type: 'AAAA'
    console.log('WeDNS: '+name+' from ' + rinfo.address +':' + rinfo.port);
    var encoded = protocol.encode({
            header: d.val.header,
            question: d.val.question,
            answers: [{
                  name:   name,
                  rtype:  1,
                  rclass: 1,
                  rttl:   300,
                  rdata:  { target: '127.0.0.1', _type: 'A' }
          }]
    }, 'answerMessage');

    DNSserver.send(encoded, 0, encoded.length, rinfo.port, rinfo.address, function (err, bytes) {
      if(err) console.log(err);
    })
  }else{
    console.log("unknown type ",d)
  }
});

DNSserver.bind(53,'127.0.0.1',function(){
  console.log('Set up DNS served from /apps folder')
});

*/
