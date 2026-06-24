<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import {
    formatEntityActivityTime,
    type EntityActivityAccountOption,
    type EntityActivityRow,
  } from './entity-activity';

  export let rows: EntityActivityRow[] = [];
  export let filteredRows: EntityActivityRow[] = [];
  export let accountOptions: EntityActivityAccountOption[] = [];
  export let accountFilter = 'all';

  const dispatch = createEventDispatcher<{
    filterChange: { accountFilter: string };
  }>();
</script>

<h4 class="section-head">Entity Activity</h4>
{#if rows.length === 0}
  <p class="muted">No entity frames with activity yet.</p>
{:else}
  <div class="entity-activity-toolbar">
    <label class="entity-activity-filter">
      <span>Account</span>
      <select
        value={accountFilter}
        on:change={(event) => dispatch('filterChange', { accountFilter: event.currentTarget.value })}
      >
        <option value="all">All accounts</option>
        {#each accountOptions as accountOption}
          <option value={accountOption.accountId}>{accountOption.accountLabel}</option>
        {/each}
      </select>
    </label>
  </div>
  <div class="entity-activity-list">
    {#if filteredRows.length === 0}
      <p class="muted">No activity for this account yet.</p>
    {:else}
      {#each filteredRows as row (row.id)}
        <article
          class="entity-activity-row"
          class:ours={row.actor === 'you'}
          class:peer={row.actor === 'peer'}
          class:system={row.actor === 'system'}
          class:queue={row.kind === 'pending' || row.kind === 'mempool'}
        >
          <div class="entity-activity-actor">
            {#if row.actorAvatar}
              <img class="entity-activity-avatar" src={row.actorAvatar} alt="" />
            {:else}
              <div class="entity-activity-avatar entity-activity-avatar-fallback">{row.actorInitials}</div>
            {/if}
            <div class="entity-activity-author-meta">
              <div class="entity-activity-author-name">{row.actorName}</div>
              <div class="entity-activity-author-badge">{row.actorLabel}</div>
            </div>
          </div>
          <div class="entity-activity-bubble">
            <div class="entity-activity-bubble-head">
              <div class="entity-activity-headline">{row.headline}</div>
              <div class="entity-activity-time">{formatEntityActivityTime(row.timestamp)}</div>
            </div>
            {#if row.bodyLines.length > 0}
              <div class="entity-activity-lines">
                {#each row.bodyLines as line}
                  <div class="entity-activity-line">{line}</div>
                {/each}
              </div>
            {/if}
            <div class="entity-activity-chips">
              {#each row.chips as chip}
                <span class="entity-activity-chip tone-{chip.tone || 'neutral'}">{chip.label}</span>
              {/each}
            </div>
            <div class="entity-activity-footer">
              <span>{row.footerLeft}</span>
              <span>{row.footerRight}</span>
            </div>
          </div>
        </article>
      {/each}
    {/if}
  </div>
{/if}

<style>
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
    margin: 0 0 12px;
  }

  .entity-activity-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .entity-activity-toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 12px;
  }

  .entity-activity-filter {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    color: #a1a1aa;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .entity-activity-filter select {
    min-height: 36px;
    min-width: 220px;
    padding: 0 12px;
    border-radius: 12px;
    border: 1px solid #2f333b;
    background: #111315;
    color: #f5f5f5;
    font-size: 13px;
  }

  .entity-activity-row {
    display: flex;
    align-items: flex-end;
    gap: 12px;
  }

  .entity-activity-row.ours {
    flex-direction: row-reverse;
  }

  .entity-activity-row.system {
    align-items: flex-start;
  }

  .entity-activity-actor {
    width: 108px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  .entity-activity-row.ours .entity-activity-actor {
    flex-direction: row-reverse;
    text-align: right;
  }

  .entity-activity-avatar {
    width: 40px;
    height: 40px;
    border-radius: 14px;
    border: 1px solid #2c3139;
    background: #121416;
    flex-shrink: 0;
  }

  .entity-activity-avatar-fallback {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #f5f5f5;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
  }

  .entity-activity-author-meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .entity-activity-author-name {
    color: #f5f5f5;
    font-size: 13px;
    font-weight: 700;
    line-height: 1.2;
  }

  .entity-activity-author-badge {
    color: #a1a1aa;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .entity-activity-bubble {
    flex: 1;
    max-width: min(760px, calc(100% - 132px));
    border-radius: 18px;
    border: 1px solid #2a2d31;
    background: linear-gradient(180deg, rgba(19, 21, 24, 0.98), rgba(13, 14, 16, 0.98));
    padding: 14px 16px;
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.22);
  }

  .entity-activity-row.ours .entity-activity-bubble {
    border-color: #454545;
    background: linear-gradient(180deg, rgba(23, 23, 23, 0.98), rgba(15, 15, 15, 0.98));
  }

  .entity-activity-row.peer .entity-activity-bubble {
    border-color: #303030;
  }

  .entity-activity-row.queue .entity-activity-bubble {
    border-style: dashed;
  }

  .entity-activity-bubble-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 8px;
  }

  .entity-activity-headline {
    color: #fafafa;
    font-size: 15px;
    font-weight: 700;
    line-height: 1.35;
  }

  .entity-activity-time {
    font-size: 11px;
    color: #8b8b8b;
    font-family: 'JetBrains Mono', monospace;
    white-space: nowrap;
  }

  .entity-activity-lines {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 12px;
  }

  .entity-activity-line {
    color: #d4d4d4;
    font-size: 13px;
    line-height: 1.45;
  }

  .entity-activity-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
  }

  .entity-activity-chip {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid #353535;
    background: #121212;
    color: #d4d4d4;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }

  .entity-activity-chip.tone-good {
    border-color: #27543a;
    color: #b7f7c6;
  }

  .entity-activity-chip.tone-warn {
    border-color: #61491c;
    color: #f3d089;
  }

  .entity-activity-chip.tone-danger {
    border-color: #633131;
    color: #f0b4b4;
  }

  .entity-activity-footer {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    color: #7a7a7a;
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
  }

  @media (max-width: 720px) {
    .entity-activity-toolbar {
      justify-content: stretch;
    }

    .entity-activity-filter,
    .entity-activity-filter select {
      width: 100%;
    }

    .entity-activity-row,
    .entity-activity-row.ours {
      flex-direction: column;
      align-items: stretch;
    }

    .entity-activity-actor,
    .entity-activity-row.ours .entity-activity-actor {
      width: 100%;
      flex-direction: row;
      text-align: left;
    }

    .entity-activity-bubble {
      max-width: 100%;
    }

    .entity-activity-bubble-head,
    .entity-activity-footer {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>
