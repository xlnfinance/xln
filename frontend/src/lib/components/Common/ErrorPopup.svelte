<script lang="ts">
  import { onMount } from 'svelte';
  import { writable } from 'svelte/store';

  interface ErrorItem {
    id: number;
    message: string;
    timestamp: number;
  }

  let errors = writable<ErrorItem[]>([]);
  let errorCounter = 0;

  function addError(message: string) {
    const error: ErrorItem = {
      id: ++errorCounter,
      message,
      timestamp: Date.now()
    };

    errors.update(items => [...items, error]);

    // Auto-remove after 10 seconds
    setTimeout(() => {
      removeError(error.id);
    }, 10000);
  }

  function removeError(id: number) {
    errors.update(items => items.filter(e => e.id !== id));
  }

  // Global error handler for window.showError
  onMount(() => {
    if (typeof window !== 'undefined') {
      (window as any).showError = addError;

      // Also catch unhandled errors
      const originalError = console.error;
      console.error = function(...args) {
        originalError.apply(console, args);

        // Only show critical errors containing specific keywords
        const errorMessage = args.map(arg =>
          typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
        ).join(' ');

        if (errorMessage.includes('createHash') ||
            errorMessage.includes('TypeError') ||
            errorMessage.includes('is not a function') ||
            errorMessage.includes('AccountInput') ||
            errorMessage.includes('CRITICAL')) {
          addError(errorMessage.slice(0, 200)); // Limit message length
        }
      };

      return () => {
        console.error = originalError;
        delete (window as any).showError;
      };
    }
    return () => {}; // Default cleanup function
  });
</script>

<div class="error-popup-container">
  {#each $errors as error (error.id)}
    <div class="error-popup">
      <div class="error-content">
        <span class="error-icon">⚠️</span>
        <span class="error-message">{error.message}</span>
      </div>
      <button class="error-close" on:click={() => removeError(error.id)}>
        ✕
      </button>
    </div>
  {/each}
</div>

<style>
  .error-popup-container {
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 400px;
  }

  .error-popup {
    background: #dc3545;
    color: white;
    padding: 12px 16px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    display: flex;
    align-items: center;
    justify-content: space-between;
    animation: slideIn 0.3s ease-out;
    min-width: 300px;
  }

  @keyframes slideIn {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  .error-content {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
  }

  .error-icon {
    font-size: 1.2em;
  }

  .error-message {
    font-family: 'SF Mono', 'Monaco', monospace;
    font-size: 0.9em;
    line-height: 1.3;
    word-break: break-word;
  }

  .error-close {
    background: none;
    border: none;
    color: white;
    cursor: pointer;
    font-size: 1.2em;
    padding: 0 0 0 10px;
    opacity: 0.8;
    transition: opacity 0.2s;
  }

  .error-close:hover {
    opacity: 1;
  }
</style>