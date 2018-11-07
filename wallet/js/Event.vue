<template>
  <tr><td>{{ev.blockId}}</td>
  <td v-html="str()"></td></tr>
</template>

<script>
export default {
  props: {
    ev: Object
  },

  data(){
    return {}
  },

  methods: {
    str: function(){
      let o = JSON.parse(this.ev.data)
      l(o)

      if (o.type == 'received') {
        return `Received ${app.commy(o.amount)} ${app.to_ticker(o.asset)} from ${o.userId}`
      } else if (o.type == 'sent') {
        return `Sent ${app.commy(o.amount)} ${app.to_ticker(o.asset)} to ${o.userId}`

      } else if (o.type == 'fee') {
        return `Paid account creation fee ${app.commy(o.amount)}`
      } else if (o.type == 'onchainfee') {
        return `Onchain tx fee ${app.commy(o.amount)}`
      } else if (o.type == 'disputeResolved') {
        return `Resolved a dispute. Received ${app.commy(o.insured)} (insured) back to ${app.onchain}, created a debt for uninsured ${app.commy(o.uninsured)} (uninsured).`
      }
    }
  }
}

</script>