<script lang="ts">
  import type { EntityReplica, Tab } from '$lib/types/ui';
  import { getXLN, xlnEnvironment } from '../../stores/xlnStore';
  import BigIntInput from '../Common/BigIntInput.svelte';

  export let replica: EntityReplica | null;
  export let tab: Tab;

  // Form state
  let counterpartyId = '';
  let giveTokenId = '1';
  let giveAmount: bigint = 0n;
  let wantTokenId = '2';
  let wantAmount: bigint = 0n;
  let minFillPercent = '50'; // Min fill ratio as percentage (0-100)

  // Get available accounts (counterparties)
  $: accounts = replica?.state?.accounts
    ? Array.from(replica.state.accounts.keys())
    : [];

  // Get available tokens from reserves
  $: availableTokens = (replica?.state?.reserves && replica.state.reserves instanceof Map)
    ? Array.from(replica.state.reserves.entries()).map(([id, reserve]) => ({
        id: id.toString(),
        name: `Token #${id}`,
        amount: reserve
      }))
    : [];

  // Get active swap offers for this entity
  $: activeOffers = replica?.state?.swapBook
    ? Array.from(replica.state.swapBook.values())
    : [];

  // Convert percentage to fill ratio (0-65535)
  function percentToFillRatio(percent: number): number {
    return Math.floor((percent / 100) * 65535);
  }

  async function placeSwapOffer() {
    if (!tab.entityId || !tab.signerId || !counterpartyId || giveAmount === 0n || wantAmount === 0n) {
      alert('Please fill all fields');
      return;
    }

    try {
      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('XLN environment not ready');

      const offerId = `swap-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const minFillRatio = percentToFillRatio(parseFloat(minFillPercent));

      xln.enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [{
        entityId: tab.entityId,
        signerId: tab.signerId,
        entityTxs: [{
          type: 'placeSwapOffer',
          data: {
            offerId,
            counterpartyId,
            giveTokenId: parseInt(giveTokenId),
            giveAmount: giveAmount,
            wantTokenId: parseInt(wantTokenId),
            wantAmount: wantAmount,
            minFillRatio,
          }
        }]
      }] });

      console.log('📊 Swap offer placed:', offerId);

      // Reset form
      giveAmount = 0n;
      wantAmount = 0n;
    } catch (error) {
      console.error('Failed to place swap offer:', error);
      alert(`Failed to place swap: ${(error as Error)?.message || 'Unknown error'}`);
    }
  }

  async function cancelSwapOffer(offerId: string, accountId: string) {
    if (!tab.entityId || !tab.signerId) return;

    try {
      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('XLN environment not ready');

      xln.enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [{
        entityId: tab.entityId,
        signerId: tab.signerId,
        entityTxs: [{
          type: 'cancelSwapOffer',
          data: {
            offerId,
            counterpartyId: accountId, // accountId is the counterparty entity ID
          }
        }]
      }] });

      console.log('🚫 Swap offer cancelled:', offerId);
    } catch (error) {
      console.error('Failed to cancel swap:', error);
      alert(`Failed to cancel: ${(error as Error)?.message || 'Unknown error'}`);
    }
  }

  // Format BigInt for display
  function formatAmount(amount: bigint): string {
    const decimals = 18n;
    const ONE = 10n ** decimals;
    const whole = amount / ONE;
    const frac = amount % ONE;
    if (frac === 0n) return whole.toString();
    return `${whole}.${frac.toString().padStart(Number(decimals), '0').replace(/0+$/, '')}`;
  }
</script>

<div class="swap-panel">
  <h3>💱 Swap Trading</h3>

  <!-- Place Swap Offer Form -->
  <div class="section">
    <h4>Place Limit Order</h4>

    <div class="form-row">
      <label>
        Counterparty (Hub)
        <select bind:value={counterpartyId}>
          <option value="">Select counterparty</option>
          {#each accounts as accountId}
            <option value={accountId}>{accountId.slice(0, 12)}...</option>
          {/each}
        </select>
      </label>
    </div>

    <div class="form-row">
      <label>
        Give Token
        <select bind:value={giveTokenId}>
          {#each availableTokens as token}
            <option value={token.id}>{token.name}</option>
          {/each}
        </select>
      </label>
      <label>
        Give Amount (wei)
        <BigIntInput bind:value={giveAmount} placeholder="Amount to sell" />
      </label>
    </div>

    <div class="form-row">
      <label>
        Want Token
        <select bind:value={wantTokenId}>
          {#each availableTokens as token}
            <option value={token.id}>{token.name}</option>
          {/each}
        </select>
      </label>
      <label>
        Want Amount (wei)
        <BigIntInput bind:value={wantAmount} placeholder="Amount to receive" />
      </label>
    </div>

    <div class="form-row">
      <label>
        Min Fill %
        <input type="number" bind:value={minFillPercent} min="1" max="100" placeholder="50" />
      </label>
    </div>

    <button class="primary-btn" on:click={placeSwapOffer}>
      📊 Place Swap Offer
    </button>
  </div>

  <!-- Active Swap Offers -->
  {#if activeOffers.length > 0}
    <div class="section">
      <h4>Active Orders ({activeOffers.length})</h4>
      <div class="offers-list">
        {#each activeOffers as offer}
          <div class="offer-card">
            <div class="offer-header">
              <span class="offer-id">{offer.offerId.slice(0, 16)}...</span>
              <button class="cancel-btn" on:click={() => cancelSwapOffer(offer.offerId, offer.accountId)}>
                🚫 Cancel
              </button>
            </div>
            <div class="offer-details">
              <div class="offer-row">
                <span class="label">Give:</span>
                <span class="value">{formatAmount(offer.giveAmount)} (Token #{offer.giveTokenId})</span>
              </div>
              <div class="offer-row">
                <span class="label">Want:</span>
                <span class="value">{formatAmount(offer.wantAmount)} (Token #{offer.wantTokenId})</span>
              </div>
              <div class="offer-row">
                <span class="label">Price:</span>
                <span class="value">
                  {(Number(offer.wantAmount) / Number(offer.giveAmount)).toFixed(6)}
                </span>
              </div>
              <div class="offer-row">
                <span class="label">Account:</span>
                <span class="value">{offer.accountId.slice(0, 12)}...</span>
              </div>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .swap-panel {
    padding: 16px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 8px;
  }

  h3 {
    margin: 0 0 16px 0;
    color: #00ff88;
    font-size: 16px;
  }

  h4 {
    margin: 0 0 12px 0;
    color: rgba(255, 255, 255, 0.9);
    font-size: 14px;
  }

  .section {
    margin-bottom: 24px;
    padding: 12px;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.05);
  }

  .form-row {
    display: flex;
    gap: 12px;
    margin-bottom: 12px;
  }

  .form-row label {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.7);
  }

  select, input {
    padding: 8px;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    color: white;
    font-size: 13px;
    font-family: 'SF Mono', monospace;
  }

  select:focus, input:focus {
    outline: none;
    border-color: rgba(0, 255, 136, 0.5);
  }

  .primary-btn {
    width: 100%;
    padding: 10px;
    background: linear-gradient(135deg, rgba(0, 255, 136, 0.2), rgba(0, 122, 204, 0.2));
    border: 1px solid rgba(0, 255, 136, 0.3);
    border-radius: 6px;
    color: #00ff88;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .primary-btn:hover {
    background: linear-gradient(135deg, rgba(0, 255, 136, 0.3), rgba(0, 122, 204, 0.3));
    border-color: rgba(0, 255, 136, 0.5);
    transform: translateY(-1px);
  }

  .offers-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .offer-card {
    padding: 12px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
  }

  .offer-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }

  .offer-id {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.5);
    font-family: 'SF Mono', monospace;
  }

  .cancel-btn {
    padding: 4px 8px;
    background: rgba(255, 68, 68, 0.1);
    border: 1px solid rgba(255, 68, 68, 0.3);
    border-radius: 3px;
    color: #ff4444;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .cancel-btn:hover {
    background: rgba(255, 68, 68, 0.2);
    border-color: rgba(255, 68, 68, 0.5);
  }

  .offer-details {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .offer-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    font-family: 'SF Mono', monospace;
  }

  .offer-row .label {
    color: rgba(255, 255, 255, 0.5);
  }

  .offer-row .value {
    color: rgba(255, 255, 255, 0.9);
  }
</style>
