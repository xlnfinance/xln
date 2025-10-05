<script lang="ts">
  import { onMount } from 'svelte';
  import { safeStringify } from '../../utils/safeStringify';

  interface ErrorItem {
    id: string;
    timestamp: string;
    message: string;
  }

  let errors: ErrorItem[] = [];
  let isVisible = false;

  onMount(() => {
    // Capture console errors and display them visually
    const originalError = console.error;
    console.error = (...args) => {
      originalError(...args);

      // Add to visual error display
      // FINTECH-SAFETY: Use safeStringify to handle BigInt values
      const errorMsg = args.map(arg =>
        typeof arg === 'object' ? safeStringify(arg, 2) : String(arg)
      ).join(' ');

      errors = [...errors.slice(-4), { // Keep last 5 errors
        timestamp: new Date().toLocaleTimeString(),
        message: errorMsg,
        id: Date.now().toString()
      }];

      isVisible = true;

      // Auto-hide after 10 seconds unless critical
      if (!errorMsg.includes('💥 CRITICAL')) {
        setTimeout(() => {
          errors = errors.filter(e => e.id !== errors[errors.length - 1]?.id);
          if (errors.length === 0) isVisible = false;
        }, 10000);
      }
    };

    // Capture unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      console.error('🚨 Unhandled Promise Rejection:', event.reason);
    });
  });

  function clearErrors() {
    errors = [];
    isVisible = false;
  }
</script>

{#if isVisible && errors.length > 0}
  <div class="error-overlay">
    <div class="error-panel">
      <div class="error-header">
        <span>🚨 Runtime Errors</span>
        <button on:click={clearErrors}>✕</button>
      </div>
      {#each errors as error}
        <div class="error-item">
          <span class="error-time">{error.timestamp}</span>
          <pre class="error-message">{error.message}</pre>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .error-overlay {
    position: fixed;
    top: 60px;
    right: 20px;
    z-index: 10000;
    max-width: 500px;
    font-family: 'Fira Code', monospace;
  }

  .error-panel {
    background: #1a1a1a;
    border: 2px solid #ff4444;
    border-radius: 8px;
    padding: 12px;
    box-shadow: 0 4px 12px rgba(255, 68, 68, 0.3);
  }

  .error-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    color: #ff4444;
    font-weight: bold;
  }

  .error-header button {
    background: none;
    border: none;
    color: #ff4444;
    cursor: pointer;
    font-size: 16px;
  }

  .error-item {
    margin: 8px 0;
    padding: 8px;
    background: #2a2a2a;
    border-radius: 4px;
    border-left: 3px solid #ff4444;
  }

  .error-time {
    color: #888;
    font-size: 11px;
    display: block;
    margin-bottom: 4px;
  }

  .error-message {
    color: #ff6666;
    font-size: 12px;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>