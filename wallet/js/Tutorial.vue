<script>
export default {
  data(){
    return {step: 1}
  }
}

</script>
<template>
  <transition-group  tag="div">
    <div :key="step" >
      <div v-if="step==1">Step 1/10: welcome.</div>
      <div v-else-if="step==2">Step 2/10: welcome.</div>
    </div>
  </transition-group>

</template>
