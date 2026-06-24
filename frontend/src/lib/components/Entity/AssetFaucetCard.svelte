<script lang="ts">
  import type { AssetLedgerRow } from './asset-ledger';

  type FaucetTarget = 'external' | 'reserve' | 'account';

  export let rows: AssetLedgerRow[] = [];
  export let selectedSymbol = '';
  export let supportsReserve = false;
  export let canShowAccountFaucet = false;
  export let submitting = false;
  export let submitFaucet: (target: FaucetTarget) => void | Promise<void>;
</script>

<section class="faucet-inline-card">
  <div class="faucet-inline-row">
    <span class="faucet-inline-label">Faucet</span>
    <select class="faucet-inline-token" bind:value={selectedSymbol} data-testid="asset-faucet-symbol">
      {#each rows as row}
        <option value={row.symbol}>{row.symbol}</option>
      {/each}
    </select>
    <button
      class="btn-table-action faucet"
      data-testid={`external-faucet-${selectedSymbol}`}
      on:click={() => submitFaucet('external')}
      disabled={submitting}
    >
      External
    </button>
    {#if supportsReserve}
      <button
        class="btn-table-action deposit"
        data-testid={`reserve-faucet-${selectedSymbol}`}
        on:click={() => submitFaucet('reserve')}
        disabled={submitting}
        title="Faucet reserve"
      >
        Reserve
      </button>
    {/if}
    {#if canShowAccountFaucet}
      <button
        class="btn-table-action faucet"
        data-testid={`account-faucet-${selectedSymbol}`}
        on:click={() => submitFaucet('account')}
        disabled={submitting}
        title="Faucet first account"
      >
        Account
      </button>
    {/if}
  </div>
</section>

<style>
  .faucet-inline-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
    padding: 10px 14px;
    border: 1px solid rgba(120, 113, 108, 0.22);
    border-radius: 14px;
    background: rgba(23, 20, 18, 0.58);
  }

  .faucet-inline-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    width: 100%;
  }

  .faucet-inline-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #fbbf24;
    white-space: nowrap;
  }

  .faucet-inline-token {
    min-width: 112px;
    max-width: 144px;
    min-height: 34px;
    padding: 6px 28px 6px 10px;
    border-radius: 10px;
    background: rgba(17, 13, 11, 0.92);
    border: 1px solid rgba(120, 113, 108, 0.32);
    color: #f5f5f4;
  }

  .btn-table-action {
    padding: 5px 10px;
    border: none;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .btn-table-action.faucet {
    background: linear-gradient(135deg, #0ea5e9, #0284c7);
    color: #f0f9ff;
  }

  .btn-table-action.faucet:hover:not(:disabled) {
    background: linear-gradient(135deg, #38bdf8, #0ea5e9);
  }

  .btn-table-action.deposit {
    background: linear-gradient(135deg, #16a34a, #15803d);
    color: #f0fdf4;
  }

  .btn-table-action.deposit:hover:not(:disabled) {
    background: linear-gradient(135deg, #22c55e, #16a34a);
  }

  .btn-table-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (max-width: 760px) {
    .faucet-inline-card {
      flex-direction: column;
      align-items: stretch;
    }

    .faucet-inline-row {
      gap: 8px;
    }

    .faucet-inline-token {
      min-width: 0;
      max-width: none;
      flex: 1 1 120px;
    }
  }
</style>
