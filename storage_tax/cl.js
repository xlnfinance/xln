var cluster = require('cluster');
if (cluster.isMaster) {
  console.log('forking')
  cluster.fork();

  cluster.on('exit', function(worker, code, signal) {
    console.log('exit')
    cluster.fork();
  });
}

if (cluster.isWorker) {
  setTimeout(()=>{console.log(333);process.exit();}, 4000)
setInterval(()=>{console.log(new Date)}, 1000)
}
