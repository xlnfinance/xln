<script lang="ts">
  import { Check, Copy } from 'lucide-svelte';
  import type { ExternalWalletSnapshotSource } from './asset-ledger';

  export let externalEoaValue = '';
  export let copied = false;
  export let snapshotSource: ExternalWalletSnapshotSource | null = null;
  export let copyExternal: () => void | Promise<void>;
  export let shortHash: (value: unknown) => string;
</script>

<div class="asset-ledger-meta">
  <div class="wallet-meta-block">
    <p class="muted wallet-label">External EOA</p>
    <button
      class="wallet-meta-copy"
      type="button"
      title="Copy external EOA"
      on:click={copyExternal}
    >
      <span class="wallet-meta-value">{externalEoaValue || '-'}</span>
      {#if copied}
        <Check size={12} />
      {:else}
        <Copy size={12} />
      {/if}
    </button>
    <p class="muted wallet-meta-help">External ETH and ERC20 endpoint.</p>
    {#if snapshotSource}
      <p
        class="muted wallet-meta-help wallet-source-line"
        data-testid="external-wallet-source"
        title={snapshotSource.sourceHash || ''}
      >
        Snapshot J#{snapshotSource.sourceHeight}
        {#if snapshotSource.sourceHash}
          · {shortHash(snapshotSource.sourceHash)}
        {/if}
        {#if snapshotSource.finalityDepth !== undefined}
          · depth {snapshotSource.finalityDepth}
        {/if}
      </p>
    {/if}
  </div>
</div>

<style>
  .muted {
    font-size: 11px;
    color: #52525b;
    line-height: 1.5;
    margin: 0 0 12px;
  }

  .wallet-label {
    margin-bottom: 0;
    font-family: 'JetBrains Mono', monospace;
    overflow-wrap: anywhere;
  }

  .asset-ledger-meta {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 16px;
    margin-bottom: 12px;
    padding-bottom: 12px;
    border-bottom: 1px solid #1f1f23;
  }

  .wallet-meta-block {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .wallet-meta-copy {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    width: fit-content;
    max-width: 100%;
    padding: 0;
    margin: 0;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    min-width: 0;
  }

  .wallet-meta-copy:hover .wallet-meta-value {
    color: #f5f5f4;
  }

  .wallet-meta-value {
    margin: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: #e7e5e4;
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .wallet-meta-help {
    margin: 0;
    max-width: 40ch;
  }

  .wallet-source-line {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #a8a29e;
    max-width: none;
  }

  @media (max-width: 900px) {
    .asset-ledger-meta {
      grid-template-columns: 1fr;
      gap: 4px;
    }
  }

  @media (max-width: 760px) {
    .asset-ledger-meta,
    .wallet-meta-block {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      box-sizing: border-box;
    }

    .wallet-meta-copy {
      width: 100%;
      justify-content: space-between;
      align-items: flex-start;
    }

    .wallet-meta-value {
      font-size: 11px;
      max-width: calc(100% - 24px);
    }
  }
</style>
