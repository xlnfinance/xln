<!--
  Toast.svelte - Beautiful non-blocking toast notifications
-->
<script lang="ts">
  import { toasts, type Toast } from '$lib/stores/toastStore';
  import { fly, fade } from 'svelte/transition';
  import { flip } from 'svelte/animate';

  let toastList: Toast[] = [];
  toasts.subscribe(t => toastList = t);
</script>

<div class="toast-container">
  {#each toastList as toast (toast.id)}
    <div
      class="toast {toast.type}"
      in:fly={{ y: 50, duration: 200 }}
      out:fade={{ duration: 150 }}
      animate:flip={{ duration: 200 }}
    >
      <span class="icon">
        {#if toast.type === 'success'}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
        {:else if toast.type === 'error'}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <circle cx="12" cy="12" r="10"/>
            <path d="M15 9l-6 6M9 9l6 6"/>
          </svg>
        {:else if toast.type === 'warning'}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        {:else}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 16v-4"/>
            <path d="M12 8h.01"/>
          </svg>
        {/if}
      </span>
      <span class="message">{toast.message}</span>
      <button class="close" on:click={() => toasts.remove(toast.id)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>
    </div>
  {/each}
</div>

<style>
  .toast-container {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 400px;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    border-radius: 12px;
    background: rgba(28, 25, 23, 0.95);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    font-size: 14px;
    color: #e7e5e4;
  }

  .toast.success {
    border-left: 3px solid #22c55e;
  }

  .toast.success .icon {
    color: #22c55e;
  }

  .toast.error {
    border-left: 3px solid #ef4444;
  }

  .toast.error .icon {
    color: #ef4444;
  }

  .toast.warning {
    border-left: 3px solid #f59e0b;
  }

  .toast.warning .icon {
    color: #f59e0b;
  }

  .toast.info {
    border-left: 3px solid #3b82f6;
  }

  .toast.info .icon {
    color: #3b82f6;
  }

  .icon {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
  }

  .icon svg {
    width: 100%;
    height: 100%;
  }

  .message {
    flex: 1;
    line-height: 1.4;
  }

  .close {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    padding: 0;
    background: transparent;
    border: none;
    color: #78716c;
    cursor: pointer;
    opacity: 0.7;
    transition: opacity 0.15s;
  }

  .close:hover {
    opacity: 1;
  }

  .close svg {
    width: 100%;
    height: 100%;
  }
</style>
