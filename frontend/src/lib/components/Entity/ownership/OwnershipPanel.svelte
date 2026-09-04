<!-- Optional Entity share issuance and reserve ownership; hub listing remains an Account action. -->
<script lang="ts">
  import { Check, CircleDollarSign, LoaderCircle, PieChart, RefreshCw, Vote } from 'lucide-svelte';
  import type { EntityShareTokenProjection } from './ownership-flow';

  export let entityName = '';
  export let entityId = '';
  export let isNumbered = false;
  export let activeIsLive = false;
  export let boardThreshold = 0n;
  export let boardMemberCount = 0;
  export let shareTokens: readonly EntityShareTokenProjection[] = [];
  export let releasePendingHash = '';
  export let releasePendingNonce: bigint | null = null;
  export let releaseConfirmedNonce = 0n;
  export let releaseBlocked = false;
  export let busy = false;
  export let error = '';
  export let takeoverTargets: readonly { entityId: string; name: string }[] = [];
  export let takeoverTargetId = '';
  export let takeoverStatus: null | {
    targetEntityId: string;
    currentBoardHash: string;
    proposedBoardHash: string;
    /** Latest jurisdiction block.timestamp (unix seconds). */
    currentUnix: bigint;
    /** Entity.activateAt: unix seconds when the pending board may be activated. */
    activateAt: bigint;
  } = null;
  export let onReleaseShares: () => void | Promise<void> = () => undefined;
  export let onRefreshTakeover: (targetEntityId: string) => void | Promise<void> = () => undefined;
  export let onProposeTakeover: (targetEntityId: string) => void | Promise<void> = () => undefined;
  export let onActivateTakeover: (targetEntityId: string) => void | Promise<void> = () => undefined;

  $: control = shareTokens.find((token) => token.shareClass === 'control') ?? null;
  $: dividend = shareTokens.find((token) => token.shareClass === 'dividend') ?? null;
  $: sharesInReserve = (control?.reserve ?? 0n) > 0n || (dividend?.reserve ?? 0n) > 0n;
  $: releaseSubmitted = Boolean(releasePendingHash) || sharesInReserve;
  $: selectedTakeoverStatus = takeoverStatus?.targetEntityId === takeoverTargetId ? takeoverStatus : null;
  $: proposedBoard = selectedTakeoverStatus?.proposedBoardHash ?? '';
  $: proposalPending = /^0x(?!0{64}$)[0-9a-f]{64}$/.test(proposedBoard);
  $: activationReady = proposalPending
    && (selectedTakeoverStatus?.activateAt ?? 0n) > 0n
    && (selectedTakeoverStatus?.currentUnix ?? 0n) >= (selectedTakeoverStatus?.activateAt ?? 0n);

  const formatUnix = (unixSeconds: bigint): string => unixSeconds <= 0n
    ? '—'
    : new Date(Number(unixSeconds) * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  const compact = (value: string): string => value.length <= 18
    ? value
    : `${value.slice(0, 10)}…${value.slice(-6)}`;
</script>

<div class="ownership" data-testid="ownership-panel">
  <header>
    <div class="mark"><PieChart size={21} /></div>
    <div class="title">
      <p>Ownership</p>
      <h2>{entityName || 'Entity'}</h2>
      <code>{compact(entityId)}</code>
    </div>
    <div class="board"><small>Board</small><strong>{boardMemberCount} · threshold {boardThreshold.toString()}</strong></div>
  </header>

  {#if sharesInReserve}
    <section class="share-grid" aria-label="Issued Entity shares">
      <article>
        <span><Check size={15} /> CONTROL</span>
        <strong>{control?.reserve.toString() ?? '0'}</strong>
        <small>Entity reserve</small>
      </article>
      <article>
        <span><Check size={15} /> DIVIDEND</span>
        <strong>{dividend?.reserve.toString() ?? '0'}</strong>
        <small>Entity reserve</small>
      </article>
    </section>
    <p class="hint">To sell shares, open an Account with the chosen hub, move the amount into that Account, then place an ordinary swap offer.</p>
    {#if releaseConfirmedNonce > 0n}<code class="receipt">confirmed nonce {releaseConfirmedNonce.toString()}</code>{/if}
  {:else}
    <section class="empty">
      <CircleDollarSign size={22} />
      <div>
        <strong>No shares issued</strong>
        <p>Optional: issue CONTROL and DIVIDEND once. Both classes first land in this Entity's Depository reserve; no hub or listing is selected here.</p>
        {#if !isNumbered}<small>Share issuance requires a numbered on-chain Entity ID.</small>{/if}
        {#if releasePendingHash}<code>action {compact(releasePendingHash)} · nonce {releasePendingNonce?.toString() ?? '—'}</code>{/if}
      </div>
      {#if !releaseSubmitted}
        <button data-testid="ownership-release-shares" disabled={!isNumbered || !activeIsLive || releaseBlocked || busy} on:click={onReleaseShares}>
          {#if busy}<LoaderCircle class="spin" size={14} />{/if}
          Issue shares
        </button>
      {/if}
    </section>
  {/if}

  {#if error}<div class="error" role="alert">{error}</div>{/if}

  <!-- Beneficial owners normally instruct a broker, which aggregates voting
       authority without forcing withdrawal. This first canonical lane counts
       settled Entity reserves directly; Hub aggregation remains a later lane.
       https://www.sec.gov/spotlight/proxyprocess/proxyvotingbrief.htm -->
  <section class="takeover" data-testid="ownership-control-takeover">
    <div class="takeover-title">
      <Vote size={18} />
      <div>
        <strong>CONTROL governance</strong>
        <p>Use settled CONTROL reserves to propose a board for an Entity where this signer already follows the full state as a minority validator.</p>
      </div>
    </div>
    {#if takeoverTargets.length === 0}
      <p class="hint">No eligible local target. First join the target board as a minority validator and synchronize its Entity history.</p>
    {:else}
      <div class="takeover-controls">
        <label>
          <span>Target Entity</span>
          <select data-testid="ownership-takeover-target" bind:value={takeoverTargetId}>
            <option value="">Select target</option>
            {#each takeoverTargets as target}
              <option value={target.entityId}>{target.name}</option>
            {/each}
          </select>
        </label>
        <button
          class="secondary"
          data-testid="ownership-takeover-refresh"
          disabled={!takeoverTargetId || busy}
          on:click={() => onRefreshTakeover(takeoverTargetId)}
        ><RefreshCw size={14} /> Refresh</button>
      </div>
      {#if selectedTakeoverStatus}
        <div class="takeover-state">
          <span>Current board <code>{compact(selectedTakeoverStatus.currentBoardHash)}</code></span>
          {#if proposalPending}
            <span>Proposal <code>{compact(proposedBoard)}</code></span>
            <span>Activation time {formatUnix(selectedTakeoverStatus.activateAt)} · chain now {formatUnix(selectedTakeoverStatus.currentUnix)}</span>
          {:else}
            <span>No pending board proposal</span>
          {/if}
        </div>
      {/if}
      <div class="takeover-actions">
        <button
          data-testid="ownership-takeover-propose"
          disabled={!takeoverTargetId || proposalPending || busy || !activeIsLive}
          on:click={() => onProposeTakeover(takeoverTargetId)}
        >Propose this signer as board</button>
        <button
          data-testid="ownership-takeover-activate"
          disabled={!takeoverTargetId || !activationReady || busy || !activeIsLive}
          on:click={() => onActivateTakeover(takeoverTargetId)}
        >Activate & hand over</button>
      </div>
    {/if}
  </section>
</div>

<style>
  .ownership { display: grid; gap: 16px; width: min(100%, 760px); margin: 0 auto; }
  header { display: flex; align-items: center; gap: 12px; padding: 16px; border: 1px solid var(--theme-border, #2b2b30); border-radius: 14px; }
  .mark { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 11px; color: var(--theme-accent, #fbbf24); background: color-mix(in srgb, var(--theme-accent, #fbbf24) 14%, transparent); }
  .title { min-width: 0; flex: 1; }
  .title p, .title h2 { margin: 0; }
  .title p, small { color: var(--theme-text-muted, #8b8b94); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
  .title h2 { margin: 2px 0 3px; font-size: 17px; }
  code { color: var(--theme-text-muted, #8b8b94); font-size: 10px; }
  .board { display: grid; gap: 4px; text-align: right; }
  .board strong { font-size: 11px; }
  .share-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  article { display: grid; gap: 6px; padding: 16px; border: 1px solid color-mix(in srgb, #22c55e 38%, var(--theme-border, #2b2b30)); border-radius: 12px; }
  article span { display: flex; align-items: center; gap: 6px; color: #86efac; font-size: 11px; }
  article strong { font: 600 15px 'JetBrains Mono', monospace; }
  .empty { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 13px; padding: 18px; border: 1px solid var(--theme-border, #2b2b30); border-radius: 14px; }
  .empty :global(svg) { color: var(--theme-text-muted, #8b8b94); }
  .empty p, .hint { margin: 5px 0; color: var(--theme-text-muted, #8b8b94); font-size: 11px; line-height: 1.5; }
  button { min-height: 36px; padding: 8px 12px; border: 1px solid color-mix(in srgb, var(--theme-accent, #fbbf24) 45%, transparent); border-radius: 9px; color: var(--theme-accent, #fbbf24); background: color-mix(in srgb, var(--theme-accent, #fbbf24) 10%, transparent); cursor: pointer; }
  button:disabled { opacity: .4; cursor: not-allowed; }
  .receipt { padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, #22c55e 8%, transparent); }
  .error { padding: 10px 12px; border-radius: 9px; color: #fecaca; background: #7f1d1d44; font-size: 11px; }
  .takeover { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--theme-border, #2b2b30); border-radius: 14px; }
  .takeover-title { display: flex; align-items: flex-start; gap: 10px; }
  .takeover-title :global(svg) { flex: none; margin-top: 2px; color: var(--theme-accent, #fbbf24); }
  .takeover-title p { margin: 4px 0 0; color: var(--theme-text-muted, #8b8b94); font-size: 11px; line-height: 1.5; }
  .takeover-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 9px; }
  label { display: grid; gap: 5px; }
  label span { color: var(--theme-text-muted, #8b8b94); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
  select { min-height: 38px; width: 100%; padding: 8px 10px; border: 1px solid var(--theme-border, #2b2b30); border-radius: 9px; color: inherit; background: var(--theme-surface, #17171a); }
  button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  button.secondary { border-color: var(--theme-border, #2b2b30); color: var(--theme-text-muted, #8b8b94); background: transparent; }
  .takeover-state { display: grid; gap: 5px; padding: 10px 12px; border-radius: 9px; background: color-mix(in srgb, var(--theme-accent, #fbbf24) 6%, transparent); font-size: 11px; }
  .takeover-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  @media (max-width: 640px) {
    header { align-items: flex-start; }
    .board { display: none; }
    .share-grid { grid-template-columns: 1fr; }
    .empty { grid-template-columns: auto minmax(0, 1fr); }
    .empty button { grid-column: 1 / -1; }
    .takeover-controls { grid-template-columns: 1fr; }
    .takeover-actions button { width: 100%; }
  }
</style>
