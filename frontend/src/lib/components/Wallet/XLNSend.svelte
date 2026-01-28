<script lang="ts">
  /**
   * XLNSend - Send XLN tokens (reserve-to-reserve)
   * MVP: Simple form to send USDC between entities
   */
  import { onMount, onDestroy } from 'svelte';

  // Props - entityId comes from parent (WalletView)
  export let entityId: string = '';

  // State
  let balance = 0n;
  let recipientAddress = '';
  let amount = '';
  let status: 'idle' | 'sending' | 'success' | 'error' = 'idle';
  let errorMessage = '';
  let loading = true;
  let faucetStatus: 'idle' | 'minting' | 'success' = 'idle';

  const ONE_TOKEN = 1000000000000000000n;
  const USDC_TOKEN_ID = 1;
  const FAUCET_AMOUNT = 100n * ONE_TOKEN; // $100 per click

  // Fetch balance periodically
  let balanceInterval: ReturnType<typeof setInterval>;

  async function fetchBalance() {
    if (!entityId) {
      balance = 0n;
      loading = false;
      return;
    }

    try {
      const { getXLN } = await import('$lib/stores/xlnStore');
      const xln = await getXLN();
      const browserVM = xln.getBrowserVMInstance?.() as any;
      if (browserVM?.getReserves) {
        balance = await browserVM.getReserves(entityId, USDC_TOKEN_ID);
      }
      loading = false;
    } catch (err) {
      console.error('Failed to fetch balance:', err);
      loading = false;
    }
  }

  // Refetch when entityId changes
  $: if (entityId) {
    loading = true;
    fetchBalance();
  }

  onMount(() => {
    fetchBalance();
    balanceInterval = setInterval(fetchBalance, 5000);
  });

  onDestroy(() => {
    if (balanceInterval) clearInterval(balanceInterval);
  });

  // Format balance as USD
  function formatUSD(value: bigint): string {
    const whole = value / ONE_TOKEN;
    const frac = ((value % ONE_TOKEN) * 100n) / ONE_TOKEN;
    return `$${whole.toLocaleString()}.${frac.toString().padStart(2, '0')}`;
  }

  // Parse amount string to bigint
  function parseAmount(str: string): bigint {
    const num = parseFloat(str);
    if (isNaN(num) || num <= 0) return 0n;
    return BigInt(Math.floor(num * 1e18));
  }

  // Validate inputs
  $: canSend = recipientAddress.length === 66 &&
               recipientAddress.startsWith('0x') &&
               parseAmount(amount) > 0n &&
               parseAmount(amount) <= balance &&
               status !== 'sending';

  async function handleSend() {
    if (!canSend || !entityId) return;

    status = 'sending';
    errorMessage = '';

    try {
      const { getXLN } = await import('$lib/stores/xlnStore');
      const xln = await getXLN();
      const browserVM = xln.getBrowserVMInstance?.() as any;
      if (!browserVM?.reserveToReserve) {
        status = 'error';
        errorMessage = 'BrowserVM not available';
        return;
      }

      const amountBigint = parseAmount(amount);
      await browserVM.reserveToReserve(entityId, recipientAddress, USDC_TOKEN_ID, amountBigint);

      // Process queued J-events to update runtime state
      if (xln.processJBlockEvents) {
        await xln.processJBlockEvents();
      }

      status = 'success';
      await fetchBalance();
      // Reset after success
      setTimeout(() => {
        status = 'idle';
        recipientAddress = '';
        amount = '';
      }, 3000);
    } catch (err) {
      status = 'error';
      errorMessage = err instanceof Error ? err.message : 'Transfer failed';
    }
  }

  function handleMaxAmount() {
    const whole = balance / ONE_TOKEN;
    const frac = balance % ONE_TOKEN;
    amount = `${whole}.${frac.toString().padStart(18, '0').slice(0, 2)}`;
  }

  // Faucet - mint $100 to entity
  async function handleFaucet() {
    if (!entityId) return;

    faucetStatus = 'minting';
    try {
      const { getXLN } = await import('$lib/stores/xlnStore');
      const xln = await getXLN();
      const browserVM = xln.getBrowserVMInstance?.() as any;
      if (!browserVM?.debugFundReserves) {
        console.error('debugFundReserves not available');
        faucetStatus = 'idle';
        return;
      }

      await browserVM.debugFundReserves(entityId, USDC_TOKEN_ID, FAUCET_AMOUNT);
      console.log(`💰 Faucet: Minted $100 to ${entityId.slice(0, 12)}...`);

      faucetStatus = 'success';
      await fetchBalance();

      setTimeout(() => {
        faucetStatus = 'idle';
      }, 2000);
    } catch (err) {
      console.error('Faucet error:', err);
      faucetStatus = 'idle';
    }
  }
</script>

<div class="xln-send">
  <div class="send-header">
    <span class="send-icon">⚡</span>
    <span class="send-title">Send XLN</span>
  </div>

  <!-- Balance Display -->
  <div class="balance-section">
    <div class="balance-label">Your Balance</div>
    <div class="balance-value" class:loading>
      {loading ? '...' : formatUSD(balance)}
    </div>
    {#if entityId}
      <div class="entity-id" title={entityId}>
        Entity: {entityId.slice(0, 10)}...{entityId.slice(-6)}
      </div>
    {/if}

    <!-- Faucet Button -->
    <button
      class="faucet-btn"
      on:click={handleFaucet}
      disabled={faucetStatus === 'minting' || !entityId}
    >
      {#if faucetStatus === 'minting'}
        💰 Minting...
      {:else if faucetStatus === 'success'}
        ✅ +$100!
      {:else}
        🚰 Get $100 (Faucet)
      {/if}
    </button>
  </div>

  <!-- Recipient -->
  <div class="field-group">
    <label>Recipient Entity ID</label>
    <input
      type="text"
      class="address-input"
      placeholder="0x... (66 characters)"
      bind:value={recipientAddress}
      class:invalid={recipientAddress && (recipientAddress.length !== 66 || !recipientAddress.startsWith('0x'))}
    />
    {#if recipientAddress && (recipientAddress.length !== 66 || !recipientAddress.startsWith('0x'))}
      <span class="field-error">Invalid entity ID (must be 66 chars starting with 0x)</span>
    {/if}
  </div>

  <!-- Amount -->
  <div class="field-group">
    <label>Amount (USDC)</label>
    <div class="amount-input-wrapper">
      <input
        type="text"
        class="amount-input"
        placeholder="0.00"
        bind:value={amount}
      />
      <button class="max-btn" on:click={handleMaxAmount}>MAX</button>
    </div>
    {#if parseAmount(amount) > balance}
      <span class="field-error">Insufficient balance</span>
    {/if}
  </div>

  <!-- Status Messages -->
  {#if status === 'success'}
    <div class="success-message">
      ✅ Transfer complete!
    </div>
  {/if}

  {#if status === 'error' && errorMessage}
    <div class="error-message">
      ❌ {errorMessage}
    </div>
  {/if}

  <!-- Send Button -->
  <button
    class="send-btn"
    on:click={handleSend}
    disabled={!canSend}
  >
    {status === 'sending' ? 'Sending...' : 'Send'}
  </button>
</div>

<style>
  .xln-send {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    padding: 16px;
  }

  .send-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .send-icon {
    font-size: 18px;
  }

  .send-title {
    font-size: 14px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.9);
  }

  .balance-section {
    text-align: center;
    padding: 20px;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 8px;
    margin-bottom: 16px;
  }

  .balance-label {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.5);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
  }

  .balance-value {
    font-size: 28px;
    font-weight: 700;
    color: rgba(100, 255, 100, 0.9);
    font-family: monospace;
  }

  .balance-value.loading {
    color: rgba(255, 255, 255, 0.3);
  }

  .entity-id {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.4);
    margin-top: 8px;
    font-family: monospace;
  }

  .faucet-btn {
    margin-top: 12px;
    padding: 10px 20px;
    background: linear-gradient(135deg, rgba(100, 150, 255, 0.3), rgba(150, 100, 255, 0.3));
    border: 1px solid rgba(150, 150, 255, 0.3);
    border-radius: 8px;
    color: rgba(200, 200, 255, 0.95);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .faucet-btn:hover:not(:disabled) {
    background: linear-gradient(135deg, rgba(100, 150, 255, 0.5), rgba(150, 100, 255, 0.5));
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(100, 150, 255, 0.2);
  }

  .faucet-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .field-group {
    margin-bottom: 14px;
  }

  .field-group label {
    display: block;
    font-size: 11px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.5);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }

  .address-input,
  .amount-input {
    width: 100%;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 13px;
    font-family: monospace;
    box-sizing: border-box;
  }

  .address-input:focus,
  .amount-input:focus {
    outline: none;
    border-color: rgba(100, 255, 100, 0.4);
  }

  .address-input.invalid {
    border-color: rgba(255, 100, 100, 0.5);
  }

  .field-error {
    display: block;
    font-size: 11px;
    color: rgba(255, 100, 100, 0.9);
    margin-top: 4px;
  }

  .amount-input-wrapper {
    display: flex;
    gap: 8px;
  }

  .amount-input-wrapper .amount-input {
    flex: 1;
  }

  .max-btn {
    padding: 10px 14px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.7);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .max-btn:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .success-message {
    padding: 12px;
    background: rgba(100, 255, 100, 0.1);
    border: 1px solid rgba(100, 255, 100, 0.2);
    border-radius: 8px;
    color: rgba(100, 255, 100, 0.9);
    font-size: 13px;
    text-align: center;
    margin-bottom: 12px;
  }

  .error-message {
    padding: 12px;
    background: rgba(255, 100, 100, 0.1);
    border: 1px solid rgba(255, 100, 100, 0.2);
    border-radius: 8px;
    color: rgba(255, 150, 150, 0.9);
    font-size: 13px;
    text-align: center;
    margin-bottom: 12px;
  }

  .send-btn {
    width: 100%;
    padding: 14px;
    background: linear-gradient(135deg, rgba(100, 255, 100, 0.8), rgba(50, 200, 100, 0.8));
    border: none;
    border-radius: 8px;
    color: #000;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .send-btn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(100, 255, 100, 0.3);
  }

  .send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    transform: none;
  }
</style>
