<script lang="ts">
  export let code: string;
  export let language: string = 'typescript';
  export let runnable: boolean = false;
  export let title: string = '';

  let copied = false;

  async function execute() {
    // TODO: Execute code when scenario engine is ready
    console.log('Execute code:', code);
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
      setTimeout(() => copied = false, 2000);
    } catch (error) {
      console.error('Failed to copy code:', error);
    }
  }
</script>

<div class="code-block">
  <div class="code-header">
    <div class="header-left">
      {#if title}
        <span class="title">{title}</span>
      {/if}
      <span class="language">{language}</span>
    </div>
    <div class="header-right">
      {#if runnable}
        <button class="run-btn" on:click={execute}>
          ▶ Run
        </button>
      {/if}
      <button class="copy-btn" on:click={copyCode}>
        {copied ? '✓ Copied!' : '📋 Copy'}
      </button>
    </div>
  </div>
  <pre><code class="language-{language}">{code}</code></pre>
</div>

<style>
  .code-block {
    margin: 1.5rem 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg-secondary);
  }

  .code-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 1rem;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .title {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text);
  }

  .language {
    font-size: 0.75rem;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .header-right {
    display: flex;
    gap: 0.5rem;
  }

  button {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text);
    padding: 0.25rem 0.75rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    transition: all 0.2s;
  }

  button:hover {
    background: var(--bg-secondary);
    border-color: var(--accent);
  }

  .run-btn {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }

  .run-btn:hover {
    opacity: 0.9;
    background: var(--accent);
  }

  .copy-btn.copied {
    border-color: #4caf50;
    color: #4caf50;
  }

  pre {
    margin: 0;
    padding: 1rem;
    overflow-x: auto;
    background: var(--bg-secondary);
  }

  code {
    font-family: 'Courier New', Courier, monospace;
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--text);
  }

  /* Simple syntax highlighting for common languages */
  :global(.language-typescript .keyword),
  :global(.language-javascript .keyword) {
    color: #c678dd;
  }

  :global(.language-typescript .string),
  :global(.language-javascript .string) {
    color: #98c379;
  }

  :global(.language-typescript .comment),
  :global(.language-javascript .comment) {
    color: #5c6370;
    font-style: italic;
  }

  :global(.language-typescript .function),
  :global(.language-javascript .function) {
    color: #61afef;
  }
</style>
