<script lang="ts">
  /**
   * XLNSend - Send XLN tokens (reserve-to-reserve)
   * MVP: Simple form to send USDC between entities
   */
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { xlnEnvironment } from '$lib/stores/xlnStore';

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

  // Token options for future extensibility
  const selectedToken = { id: 1, symbol: 'USDC', name: 'USD Coin' };

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
      const env = get(xlnEnvironment);
      const jadapter = xln.getActiveJAdapter?.(env);
      if (jadapter?.getReserves) {
        balance = await jadapter.getReserves(entityId, USDC_TOKEN_ID);
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

  // Validate inputs - block self-transfer
  $: isSelfTransfer = recipientAddress.toLowerCase() === entityId.toLowerCase();
  $: canSend = recipientAddress.length === 66 &&
               recipientAddress.startsWith('0x') &&
               !isSelfTransfer &&
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
      const env = get(xlnEnvironment);
      const jadapter = xln.getActiveJAdapter?.(env);
      if (!jadapter?.reserveToReserve) {
        status = 'error';
        errorMessage = 'J-adapter not available';
        return;
      }

      const amountBigint = parseAmount(amount);
      await jadapter.reserveToReserve(entityId, recipientAddress, USDC_TOKEN_ID, amountBigint);

      // Process queued J-events to update runtime state
      if (xln.processJBlockEvents && env) {
        await xln.processJBlockEvents(env);
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
      const env = get(xlnEnvironment);
      const jadapter = xln.getActiveJAdapter?.(env);
      if (!jadapter?.debugFundReserves) {
        console.error('debugFundReserves not available');
        faucetStatus = 'idle';
        return;
      }

      await jadapter.debugFundReserves(entityId, USDC_TOKEN_ID, FAUCET_AMOUNT);
      console.log(`Faucet: Minted $100 to ${entityId.slice(0, 12)}...`);

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

<div class="send-card">
  <!-- Balance Section -->
  <div class="balance-section">
    <div class="balance-row">
      <span class="balance-label">Available balance</span>
      <button
        class="faucet-btn"
        on:click={handleFaucet}
        disabled={faucetStatus === 'minting' || !entityId}
      >
        {#if faucetStatus === 'minting'}
          Requesting...
        {:else if faucetStatus === 'success'}
          +$100 added
        {:else}
          Request test funds
        {/if}
      </button>
    </div>
    <div class="balance-amount" class:loading>
      {loading ? '—' : formatUSD(balance)}
    </div>
  </div>

  <!-- Amount Input (Stripe-style) -->
  <div class="amount-section">
    <span class="field-label">Amount</span>
    <div class="amount-input-group">
      <span class="currency-symbol">$</span>
      <input
        type="text"
        class="amount-input"
        placeholder="0.00"
        bind:value={amount}
      />
      <button class="token-badge" title={selectedToken.name}>
        {selectedToken.symbol}
      </button>
      <button class="max-btn" on:click={handleMaxAmount}>Max</button>
    </div>
    {#if parseAmount(amount) > balance}
      <span class="field-error">Insufficient balance</span>
    {/if}
  </div>

  <!-- Recipient Input -->
  <div class="recipient-section">
    <span class="field-label">Recipient</span>
    <input
      type="text"
      class="recipient-input"
      placeholder="Entity ID (0x...)"
      bind:value={recipientAddress}
      class:invalid={recipientAddress && (recipientAddress.length !== 66 || !recipientAddress.startsWith('0x'))}
    />
    {#if recipientAddress && (recipientAddress.length !== 66 || !recipientAddress.startsWith('0x'))}
      <span class="field-error">Invalid entity ID format</span>
    {:else if isSelfTransfer}
      <span class="field-error">Cannot send to yourself</span>
    {/if}
  </div>

  <!-- Status Messages -->
  {#if status === 'success'}
    <div class="status-banner success">
      Transfer complete
    </div>
  {/if}

  {#if status === 'error' && errorMessage}
    <div class="status-banner error">
      {errorMessage}
    </div>
  {/if}

  <!-- Send Button -->
  <button
    class="send-btn"
    on:click={handleSend}
    disabled={!canSend}
  >
    {status === 'sending' ? 'Sending...' : 'Send payment'}
  </button>
</div>

<style>
  .send-card {
    background: #0a0a0a;
    border: 1px solid #1f1f1f;
    border-radius: 12px;
    padding: 20px;
  }

  /* Balance Section */
  .balance-section {
    margin-bottom: 24px;
    padding-bottom: 20px;
    border-bottom: 1px solid #1a1a1a;
  }

  .balance-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .balance-label {
    font-size: 12px;
    color: #666;
    font-weight: 500;
  }

  .balance-amount {
    font-size: 32px;
    font-weight: 600;
    color: #e5e5e5;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif;
    letter-spacing: -0.02em;
  }

  .balance-amount.loading {
    color: #333;
  }

  .faucet-btn {
    padding: 6px 12px;
    background: transparent;
    border: 1px solid #2a2a2a;
    border-radius: 6px;
    color: #888;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .faucet-btn:hover:not(:disabled) {
    border-color: #3b82f6;
    color: #3b82f6;
  }

  .faucet-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Amount Section */
  .amount-section {
    margin-bottom: 16px;
  }

  .field-label {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: #666;
    margin-bottom: 8px;
  }

  .amount-input-group {
    display: flex;
    align-items: center;
    background: #111;
    border: 1px solid #222;
    border-radius: 8px;
    padding: 0 4px;
    transition: border-color 0.15s ease;
  }

  .amount-input-group:focus-within {
    border-color: #3b82f6;
  }

  .currency-symbol {
    padding: 0 8px 0 12px;
    color: #555;
    font-size: 18px;
    font-weight: 500;
  }

  .amount-input {
    flex: 1;
    padding: 14px 0;
    background: transparent;
    border: none;
    color: #e5e5e5;
    font-size: 18px;
    font-weight: 500;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif;
  }

  .amount-input::placeholder {
    color: #333;
  }

  .amount-input:focus {
    outline: none;
  }

  .token-badge {
    padding: 6px 10px;
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 6px;
    color: #888;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    cursor: default;
  }

  .max-btn {
    padding: 6px 10px;
    margin: 0 4px;
    background: transparent;
    border: 1px solid #2a2a2a;
    border-radius: 6px;
    color: #666;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .max-btn:hover {
    border-color: #444;
    color: #888;
  }

  /* Recipient Section */
  .recipient-section {
    margin-bottom: 20px;
  }

  .recipient-input {
    width: 100%;
    padding: 12px 14px;
    background: #111;
    border: 1px solid #222;
    border-radius: 8px;
    color: #e5e5e5;
    font-size: 13px;
    font-family: 'SF Mono', 'JetBrains Mono', monospace;
    box-sizing: border-box;
    transition: border-color 0.15s ease;
  }

  .recipient-input::placeholder {
    color: #444;
  }

  .recipient-input:focus {
    outline: none;
    border-color: #3b82f6;
  }

  .recipient-input.invalid {
    border-color: #dc2626;
  }

  .field-error {
    display: block;
    font-size: 11px;
    color: #ef4444;
    margin-top: 6px;
  }

  /* Status Messages */
  .status-banner {
    padding: 12px 14px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    text-align: center;
    margin-bottom: 16px;
  }

  .status-banner.success {
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.2);
    color: #22c55e;
  }

  .status-banner.error {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.2);
    color: #ef4444;
  }

  /* Send Button */
  .send-btn {
    width: 100%;
    padding: 14px;
    background: #3b82f6;
    border: none;
    border-radius: 8px;
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .send-btn:hover:not(:disabled) {
    background: #2563eb;
  }

  .send-btn:disabled {
    background: #1e3a5f;
    color: #4b7bb8;
    cursor: not-allowed;
  }
</style>
