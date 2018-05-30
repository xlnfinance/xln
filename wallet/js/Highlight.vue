<template>
  <pre><code :class="{hljs: !white}" v-html="renderedCode"></code></pre>
</template>

<script>
import * as hljs from 'highlight.js/lib/highlight.js'

hljs.registerLanguage('javascript', require('highlight.js/lib/languages/javascript'))
hljs.registerLanguage('diff', require('highlight.js/lib/languages/diff'))
hljs.registerLanguage('bash', require('highlight.js/lib/languages/bash'))

export default {
  props: ['lang', 'code', 'white'],

  computed: {
    renderedCode() {
      return hljs.highlight(this.lang, this.code || '').value
    }
  }
}
</script>
