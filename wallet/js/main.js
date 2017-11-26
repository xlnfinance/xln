
l=console.log

render = r=>{
  Object.assign(app, r)
}


W.onready(()=>{
  W('load').then(init=>{
    l("starting vue with "+init)
      
    app = new Vue({
      el: '#app',
      data: init,
      methods:{
        derive: f=>{
          var data = {
            username: inputUsername.value, 
            password: inputPassword.value
          }
          if(!app.K) data.location = inputLocation.value

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
        }


      }
    })

  })
})


