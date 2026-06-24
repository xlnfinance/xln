<script lang="ts">
  type PendingBatchPreviewItem = {
    key: string;
    title: string;
    subtitle: string;
  };

  export let debtCount = 0;
  export let debtUsdLabel = '';
  export let debtNote = '';
  export let pendingCount = 0;
  export let pendingMode: 'draft' | 'sent' | null = null;
  export let reserveIssueText: string | null = null;
  export let previewItems: PendingBatchPreviewItem[] = [];
  export let submitting = false;
  export let hasSentBatch = false;
  export let canBroadcast = false;
  export let openHistory: () => void | Promise<void>;
  export let clearBatch: () => void | Promise<void>;
  export let rebroadcastBatch: () => void | Promise<void>;
  export let broadcastBatch: () => void | Promise<void>;
</script>

{#if debtCount > 0}
  <div class="workspace-debt-warning" data-testid="workspace-debt-warning">
    <div class="workspace-debt-warning-copy">
      <span class="workspace-debt-warning-kicker">Open debts across all tokens</span>
      <strong>{debtCount} open · {debtUsdLabel}</strong>
    </div>
    <span class="workspace-debt-warning-note">{debtNote}</span>
  </div>
{/if}

{#if pendingCount > 0}
  <div
    class="workspace-pending-banner"
    data-testid="workspace-pending-banner"
    data-pending-count={pendingCount}
  >
    <div class="workspace-pending-copy">
      <div class="workspace-pending-head">
        <span class="workspace-pending-kicker">{pendingMode === 'sent' ? 'Sent Batch' : 'Draft Batch'}</span>
        <span class="workspace-pending-note">What will go on-chain next</span>
      </div>
      {#if reserveIssueText}
        <div class="workspace-pending-alert">{reserveIssueText}</div>
      {/if}
      <div class="workspace-pending-list">
        {#each previewItems as item (item.key)}
          <div class="workspace-pending-chip">
            <strong>{item.title}</strong>
            <span>{item.subtitle}</span>
          </div>
        {/each}
      </div>
    </div>
    <div class="workspace-pending-actions">
      <button class="btn-table-action" type="button" on:click={openHistory}>History</button>
      <button class="btn-table-action" type="button" data-testid="settle-clear-batch" on:click={clearBatch} disabled={submitting}>Clear Batch</button>
      {#if hasSentBatch}
        <button class="btn-table-action deposit" type="button" data-testid="settle-rebroadcast" on:click={rebroadcastBatch} disabled={submitting}>
          {submitting ? 'Working...' : 'Rebroadcast'}
        </button>
      {:else}
        <button class="btn-table-action deposit" type="button" data-testid="settle-sign-broadcast" on:click={broadcastBatch} disabled={!canBroadcast || submitting}>
          {submitting ? 'Working...' : 'Sign & Broadcast'}
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .workspace-pending-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    margin-bottom: 12px;
    border-radius: 14px;
    border: 1px solid rgba(236, 179, 55, 0.35);
    background: rgba(236, 179, 55, 0.08);
    color: rgba(255, 242, 213, 0.96);
  }

  .workspace-debt-warning {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 11px 14px;
    margin-bottom: 12px;
    border-radius: 14px;
    border: 1px solid rgba(248, 113, 113, 0.26);
    background: rgba(127, 29, 29, 0.16);
    color: #fee2e2;
  }

  .workspace-debt-warning-copy {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 10px;
  }

  .workspace-debt-warning-kicker {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #fca5a5;
  }

  .workspace-debt-warning-note {
    font-size: 12px;
    color: rgba(254, 226, 226, 0.84);
  }

  .workspace-pending-copy {
    display: grid;
    gap: 10px;
    min-width: 0;
    flex: 1;
  }

  .workspace-pending-head {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: baseline;
  }

  .workspace-pending-kicker {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #ffd56a;
  }

  .workspace-pending-note {
    font-size: 12px;
    color: rgba(255, 242, 213, 0.82);
  }

  .workspace-pending-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .workspace-pending-alert {
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(127, 29, 29, 0.28);
    border: 1px solid rgba(248, 113, 113, 0.22);
    color: #fecaca;
    font-size: 12px;
    line-height: 1.4;
  }

  .workspace-pending-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
  }

  .workspace-pending-chip {
    display: grid;
    gap: 3px;
    min-width: 160px;
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(8, 10, 14, 0.36);
    border: 1px solid rgba(236, 179, 55, 0.18);
  }

  .workspace-pending-chip strong {
    font-size: 12px;
    color: #fff5d9;
  }

  .workspace-pending-chip span {
    font-size: 11px;
    line-height: 1.35;
    color: rgba(255, 242, 213, 0.74);
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
    .workspace-pending-banner,
    .workspace-pending-copy,
    .workspace-pending-list,
    .workspace-pending-actions,
    .workspace-pending-chip {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      box-sizing: border-box;
    }

    .workspace-pending-banner,
    .workspace-debt-warning {
      flex-direction: column;
      align-items: stretch;
    }

    .workspace-pending-actions,
    .workspace-debt-warning-copy {
      width: 100%;
      justify-content: flex-start;
    }

    .workspace-pending-chip {
      min-width: 0;
      width: 100%;
    }
  }
</style>
