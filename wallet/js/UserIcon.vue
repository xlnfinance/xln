<template>
  <img
    :width="size"
    :height="size"
    :src="src"
  />
</template>

<script>
let Identicon = require('identicon.js')

export default {
  props: ['hash', 'size'],
  computed: {
    src() {
      let icon = new Identicon(
        this.hash.toString(),
        this.size.toString()
      ).toString()
      return `data:image/png;base64,${icon}`
    }
  }
}
</script>
