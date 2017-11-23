

var hash = location.hash.split('code=')
if(hash[1]){
  document.cookie = 'code='+hash[1].replace(/[^a-z0-9]/g,'')
  location.hash=''
}



