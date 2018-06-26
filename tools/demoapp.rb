# fair SDK demo for ruby + sinatra

require 'sinatra'
require 'json'
require 'open-uri'


set :public_folder, Proc.new {File.join(root, ".")}

fs_origin = 'http://127.0.0.1:8001'
FS_RPC = 'http://127.0.0.1:8002/rpc'
if File.exists? '/root/fs/data8002/offchain/pk.json'
  FS_PATH = '/root/fs/data8002/offchain'
else
  FS_PATH = '/Users/homakov/work/fs/data8002/offchain'
end




if File.exists? FS_PATH + '/pk.json'
  $auth_code = JSON.parse(File.read(FS_PATH + '/pk.json'))['auth_code']
  puts 'Auth code to our node: ' + $auth_code

  def fair (data)
    url = FS_RPC+'?auth_code='+$auth_code+'&'+data
    puts url
    JSON.parse(open(url).read)
  end

  data = fair('method=getinfo')
  puts data
  if data['address']
    address = data['address']
  end

  def processUpdates
    puts fair('method=receivedAndFailed')
  end
  
  processUpdates

else
  p "No auth"
end





get '/' do
  request.cookies[:id] ||= rand(999999)


  r =<<HTML
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="/bootstrap.min.css">
  <script src="/axios.js"></script>
  <script src="/demoapp_common.js"></script>
  <title>Fairlayer Integration Demo</title>

  <script>
  fs_origin = '#{fs_origin}'
  address = '#{address}'
  id = '#{request.cookies[:id]}'
  </script>
</head>

<body>
  <main role="main" class="container" id="main">
    <h1 class="mt-5">Fairlayer Integration Demo (Ruby)</h1>
    <p>Your account in our service: <span id="yourid"></span></p>
    <p>Available FRD Balance: <b>\$${commy(users[id])}</b></p>

    <h3>Deposit FRD</h3>
    <p>Deposit Address: <a href="#" id="deposit"></a></p>

    <h3>Withdraw FRD</h3>
    <p><input type="text" id="destination" placeholder="Address"></p>
    <p><input type="text" id="out_amount" placeholder="Amount"></p>
    <p><button class="btn btn-success" id="withdraw">Withdraw</button></p>
    <a href="https://fairlayer.com/#install">Install Fairlayer</a>
 </main>
</body></html>
HTML
end