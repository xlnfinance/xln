<template>
  <tr><td>{{ev.blockId}}</td>
  <td>{{ev.desc}}</td></tr>
</template>

<script>
export default {
  props: {
    ev: Object
  },

  data(){
    return {}
  }
}

</script>