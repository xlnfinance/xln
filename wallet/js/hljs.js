import * as hljs from 'highlight.js/lib/highlight.js'

hljs.registerLanguage('javascript', require('highlight.js/lib/languages/javascript'))
hljs.registerLanguage('diff', require('highlight.js/lib/languages/diff'))
hljs.registerLanguage('bash', require('highlight.js/lib/languages/bash'))

export default hljs.highlight
