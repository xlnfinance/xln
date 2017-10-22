var protocol = require('./protocol');
var server = require('dgram').createSocket('udp6');
var named=require('node-named')


server.on('message', function(buffer, rinfo) {
  var d = protocol.decode(buffer, 'queryMessage')
  var name = d.val.question.name
  console.log('requesting '+name+' server got from ' + rinfo.address +':' + rinfo.port);
  if(name.endsWith('.we')){
    d.val.header.flags.qr=1
    d.val.header.anCount=1

    console.log(d)
    var encoded = protocol.encode({
            header: d.val.header,
            question: d.val.question,
            answers: [{
                  name:   name,
                  rtype:  1,
                  rclass: 1,
                  rttl:   3600,
                  rdata:  new named.ARecord('127.0.0.1')
          }]
    }, 'answerMessage');
    server.send(encoded, 0, encoded.length, rinfo.port, rinfo.address, function (err, bytes) {
      console.log(err, bytes)
    })
  }
});
// need sudo
//server.bind(53, '127.0.0.1');
server.bind(53);
