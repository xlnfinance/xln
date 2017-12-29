normalws = require('ws')

function WebSocketClient(){
  this.number = 0;  // Message number
  this.autoReconnectInterval = 5*1000;  // ms
}
WebSocketClient.prototype.open = function(url){
  this.url = url;
  this.instance = new normalws(this.url);
  this.instance.on('open',()=>{
    this.onopen();
  });
  this.instance.on('message',(data,flags)=>{
    this.number ++;
    this.onmessage(data,flags,this.number);
  });
  this.instance.on('close',(e)=>{
    switch (e){
    case 1000:  // CLOSE_NORMAL
      console.log("WebSocket: closed");
      break;
    default:  // Abnormal closure
      this.reconnect(e);
      break;
    }
    this.onclose(e);
  });
  this.instance.on('error',(e)=>{
    switch (e.code){
    case 'ECONNREFUSED':
      this.reconnect(e);
      break;
    default:
      this.onerror(e);
      break;
    }
  });
}
WebSocketClient.prototype.send = function(data,option){
  try{
    this.instance.send(data,option);
  }catch (e){
    this.instance.emit('error',e);
  }
}
WebSocketClient.prototype.reconnect = function(e){
  //console.log(`WebSocketClient: retry in ${this.autoReconnectInterval}ms`);
        this.instance.removeAllListeners();
  var that = this;
  setTimeout(function(){
    //var connected = 0
    //me.members.map(o=>{if(o.socket) connected++})
    //console.log("WebSocketClient: reconnecting... Have "+connected);
    that.open(that.url);
  },this.autoReconnectInterval);
}
WebSocketClient.prototype.onopen = function(e){
  console.log("WebSocketClient: open",arguments);
}
WebSocketClient.prototype.onmessage = function(data,flags,number){  //console.log("WebSocketClient: message",arguments);
}
WebSocketClient.prototype.onerror = function(e){
  console.log("Couldn't reach "+e.host);
}
WebSocketClient.prototype.onclose = function(e){  console.log("WebSocketClient: closed",arguments); }


module.exports = WebSocketClient
