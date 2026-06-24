<script context="module" lang="ts">
  export type DisputedAccountView = {
    counterpartyId: string;
    status: 'active' | 'finalized';
  };
</script>

<script lang="ts">
  import type { Env } from '@xln/runtime/xln-api';
  import type { EntityReplica, Tab } from '$lib/types/ui';
  import EntityInput from '../shared/EntityInput.svelte';
  import HubDiscoveryPanel from './HubDiscoveryPanel.svelte';
  import { requireRuntimeEnv } from './entity-panel-model';

  export let replica: EntityReplica | null = null;
  export let tab: Tab;
  export let activeIsLive = false;
  export let actionRuntimeEnv: Env | null = null;
  export let openAccountEntityId = '';
  export let openAccountEntityOptions: string[] = [];
  export let disputedAccounts: DisputedAccountView[] = [];
  export let handleOpenAccountTargetChange: (event: CustomEvent<{ value?: string }>) => void;
  export let openAccountWithFullId: (targetEntityId: string) => void | Promise<void>;
  export let openDisputedAccount: (counterpartyEntityId: string) => void;
  export let reopenDisputedAccount: (counterpartyEntityId: string) => void | Promise<void>;
</script>

<div class="account-open-sections">
  <div class="open-section">
    <div class="open-section-head">
      <div class="open-section-copy">
        <span class="open-section-kicker">Network</span>
        <h4 class="section-head">Open Account</h4>
      </div>
    </div>
    {#if activeIsLive && actionRuntimeEnv}
      <HubDiscoveryPanel
        entityId={replica?.state?.entityId || tab.entityId}
        env={requireRuntimeEnv(actionRuntimeEnv, 'hub-discovery')}
      />
    {/if}
  </div>
  <div class="open-section">
    <div class="open-section-head compact">
      <div class="open-section-copy">
        <span class="open-section-kicker">Direct</span>
        <h4 class="section-head">Open by ID</h4>
      </div>
    </div>
    <div class="open-private-form">
      <EntityInput
        variant="move"
        label="Recipient"
        value={openAccountEntityId}
        entities={openAccountEntityOptions}
        excludeId={replica?.state?.entityId || tab.entityId}
        placeholder="Select or paste entity ID"
        disabled={!activeIsLive}
        on:change={handleOpenAccountTargetChange}
      />
      <button
        class="btn-add"
        on:click={() => openAccountWithFullId(openAccountEntityId)}
        disabled={!activeIsLive || !openAccountEntityId.trim()}
      >
        Open
      </button>
    </div>
  </div>

  {#if disputedAccounts.length > 0}
    <div class="open-section disputed-section">
      <h4 class="section-head">Disputed Accounts</h4>
      <p class="muted">Hidden from the main list. Open active disputes, reopen only after finalize.</p>
      <div class="disputed-list">
        {#each disputedAccounts as item (item.counterpartyId)}
          <div class="disputed-row">
            <div class="disputed-meta">
              <div class="disputed-id">{item.counterpartyId}</div>
              <div class="disputed-state">
                {item.status === 'active'
                  ? 'Active dispute in progress'
                  : 'Finalized disputed account'}
              </div>
            </div>
            {#if item.status === 'active'}
              <button
                class="btn-reopen-disputed"
                on:click={() => openDisputedAccount(item.counterpartyId)}
              >
                Open
              </button>
            {:else}
              <button
                class="btn-reopen-disputed"
                on:click={() => reopenDisputedAccount(item.counterpartyId)}
                disabled={!activeIsLive}
              >
                Reopen
              </button>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .account-open-sections {
    display: grid;
    grid-template-columns: minmax(0, 1.7fr) minmax(300px, 0.95fr);
    gap: 14px;
    margin-top: 8px;
    align-items: start;
  }

  .open-section {
    padding: 15px 16px;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 56%, transparent);
    border-radius: 14px;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--theme-accent, #fbbf24) 2%, transparent), transparent 24%),
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 98%, transparent),
        color-mix(in srgb, var(--theme-input-bg, #09090b) 100%, transparent)
      );
    box-shadow: 0 6px 16px color-mix(in srgb, var(--theme-background, #09090b) 4%, transparent);
    min-width: 0;
  }

  .open-section-head {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
  }

  .open-section-head.compact {
    margin-bottom: 12px;
  }

  .open-section-copy {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }

  .open-section-kicker {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.01em;
    text-transform: none;
    color: var(--theme-accent, #fbbf24);
  }

  .open-private-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .disputed-section {
    grid-column: 1 / -1;
    padding: 16px 18px;
    border-color: rgba(244, 63, 94, 0.25);
    background: linear-gradient(180deg, rgba(244, 63, 94, 0.08), rgba(15, 23, 42, 0.16));
    border: 1px solid rgba(244, 63, 94, 0.25);
    border-radius: 16px;
  }

  .disputed-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .disputed-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 12px 14px;
    border: 1px solid rgba(244, 63, 94, 0.2);
    border-radius: 14px;
    background: rgba(15, 23, 42, 0.5);
  }

  .disputed-meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .disputed-id {
    color: #e2e8f0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    word-break: break-all;
  }

  .disputed-state {
    color: #fda4af;
    font-size: 11px;
  }

  .btn-reopen-disputed {
    min-height: 38px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid rgba(251, 191, 36, 0.35);
    background: rgba(251, 191, 36, 0.12);
    color: #fde68a;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    white-space: nowrap;
  }

  .btn-reopen-disputed:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-add {
    padding: 8px 16px;
    background: var(--theme-accent, #fbbf24);
    color: var(--theme-accent-contrast, #000);
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .btn-add:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .section-head {
    margin: 0 0 12px;
    color: #f5f5f5;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.01em;
  }

  .muted {
    color: #52525b;
    line-height: 1.5;
    margin: 0;
  }

  @media (max-width: 900px) {
    .account-open-sections {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 760px) {
    .account-open-sections {
      gap: 8px;
    }

    .open-section,
    .disputed-section {
      padding: 12px;
    }

    .open-section-head,
    .open-section-head.compact {
      margin-bottom: 10px;
      gap: 4px;
    }

    .open-section-copy {
      gap: 6px;
    }

    .open-section-kicker {
      font-size: 8.5px;
    }
  }
</style>
