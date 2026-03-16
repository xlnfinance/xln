<script lang="ts">
  import { resetEverything } from '$lib/utils/resetEverything';

  let resetting = $state(false);

  async function handleReset() {
    if (!confirm('Reset ALL data? Wallets, accounts, settings — everything will be wiped.')) return;
    resetting = true;
    await resetEverything();
  }
</script>

<div class="emergency-bar">
  <button class="reset-btn" onclick={handleReset} disabled={resetting}>
    {resetting ? 'Resetting...' : 'RESET'}
  </button>
</div>

<style>
  .emergency-bar {
    position: fixed;
    top: 0;
    right: 0;
    z-index: 99999;
    padding: 4px 8px;
  }
  .reset-btn {
    background: transparent;
    color: #666;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 2px 10px;
    font-size: 10px;
    font-family: monospace;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 1px;
    transition: all 0.2s;
  }
  .reset-btn:hover {
    background: #dc2626;
    color: white;
    border-color: #dc2626;
  }
  .reset-btn:disabled {
    opacity: 0.5;
    cursor: wait;
  }
</style>
