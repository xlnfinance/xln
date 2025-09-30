<script lang="ts">
  export let variant: 'primary' | 'secondary' | 'danger' = 'primary';
  export let size: 'small' | 'medium' | 'large' = 'medium';
  export let disabled = false;
  export let type: 'button' | 'submit' | 'reset' = 'button';
</script>

<button 
  class="btn btn-{variant} btn-{size}" 
  {disabled} 
  {type}
  on:click
>
  <slot />
</button>

<style>
  .btn {
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-weight: 500;
    transition: all 0.3s ease;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  /* Sizes */
  .btn-small {
    padding: 6px 12px;
    font-size: 12px;
  }

  .btn-medium {
    padding: 10px 20px;
    font-size: 14px;
  }

  .btn-large {
    padding: 12px 24px;
    font-size: 16px;
  }

  /* Variants */
  .btn-primary {
    background: #007acc;
    color: white;
  }

  .btn-primary:hover:not(:disabled) {
    background: #0086e6;
  }

  .btn-secondary {
    background: #6c757d;
    color: white;
  }

  .btn-secondary:hover:not(:disabled) {
    background: #5a6268;
  }

  .btn-danger {
    background: #dc3545;
    color: white;
  }

  .btn-danger:hover:not(:disabled) {
    background: #c82333;
  }
</style>
