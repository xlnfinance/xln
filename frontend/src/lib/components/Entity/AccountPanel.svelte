<script lang="ts">
  import type { AccountMachine, EntityReplica, Tab } from '$lib/types/ui';
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { p2pState, xlnEnvironment, xlnFunctions } from '../../stores/xlnStore';
  import EntityIdentity from '../shared/EntityIdentity.svelte';
  import DeltaTokenSummary from './shared/DeltaTokenSummary.svelte';
  import { resolveEntityName } from '$lib/utils/entityNaming';
  import { getAccountUiStatus, getAccountUiStatusLabel } from '$lib/utils/accountStatus';

  export let account: AccountMachine;
  export let counterpartyId: string;
  export let entityId: string;
  export let replica: EntityReplica | null = null;
  export let tab: Tab | null = null;

  const dispatch = createEventDispatcher();

  $: activeXlnFunctions = $xlnFunctions;
  $: activeEnv = $xlnEnvironment;

  let expandedTokenIds = new Set<number>();
  let nowMs = Date.now();
  let nowTimer: ReturnType<typeof setInterval> | null = null;
  let liveJHeightTimer: ReturnType<typeof setInterval> | null = null;
  let liveJHeight = 0;

  $: iAmLeft = entityId < counterpartyId;
  $: pendingCount = (account.mempool?.length || 0) + (account.pendingFrame ? 1 : 0);
  $: mempoolCount = Number(account.mempool?.length || 0);
  $: hasPendingConsensus = Boolean(account.pendingFrame);
  $: hasQueuedMempool = mempoolCount > 0;
  $: activeDispute = account.activeDispute ?? null;
  $: uiStatus = getAccountUiStatus(account);
  $: uiStatusLabel = getAccountUiStatusLabel(uiStatus);
  $: disputeTimeoutBlock = Number(activeDispute?.disputeTimeout ?? 0);
  $: currentJHeight = Math.max(
    Number(account.lastFinalizedJHeight ?? 0),
    Number(replica?.state?.lastFinalizedJHeight ?? 0),
    Number(liveJHeight || 0),
  );
  $: disputeBlocksLeft = activeDispute ? Math.max(0, disputeTimeoutBlock - currentJHeight) : 0;

  $: reconnectCountdown = (() => {
    if (!$p2pState.reconnect) return null;
    const remaining = Math.max(0, Math.ceil(($p2pState.reconnect.nextAt - nowMs) / 1000));
    return { seconds: remaining, attempt: $p2pState.reconnect.attempt };
  })();
  $: relayStatus = $p2pState.connected ? 'connected' : reconnectCountdown ? 'reconnecting' : 'disconnected';

  $: counterpartyName = resolveEntityName(counterpartyId, activeEnv);

  $: tokenDetails = (() => {
    if (!activeXlnFunctions?.deriveDelta) return [];
    return Array.from(account.deltas?.entries() || []).map(([tokenId, delta]) => {
      const derived = activeXlnFunctions.deriveDelta(delta, iAmLeft);
      const peerDerived = activeXlnFunctions.deriveDelta(delta, !iAmLeft);
      const tokenInfo = activeXlnFunctions.getTokenInfo(tokenId) || {
        symbol: `TKN${tokenId}`,
        color: '#999',
        name: `Token ${tokenId}`,
        decimals: 18,
      };
      return {
        tokenId,
        tokenInfo,
        delta,
        derived,
        peerDerived,
        ourCreditLimit: iAmLeft ? delta.leftCreditLimit : delta.rightCreditLimit,
        theirCreditLimit: iAmLeft ? delta.rightCreditLimit : delta.leftCreditLimit,
      };
    });
  })();
  $: hasCommittedFrame = Number(account.currentHeight || 0) > 0;
  $: showTokenDetails = hasCommittedFrame && tokenDetails.length > 0;

  function formatTimestamp(ms: number): string {
    return new Date(ms).toLocaleTimeString();
  }

  function summarizeTxTypes(
    txs: Array<{ type?: string } | null | undefined> | null | undefined,
  ): Array<{ type: string; count: number }> {
    const counts = new Map<string, number>();
    for (const tx of txs || []) {
      const type = String(tx?.type || 'unknown');
      counts.set(type, (counts.get(type) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([type, count]) => ({ type, count }));
  }

  function txTypeLabel(type: string): string {
    const known: Record<string, string> = {
      request_collateral: 'Request Collateral',
      set_rebalance_policy: 'Set Rebalance Policy',
      request_withdrawal: 'Request Withdrawal',
      approve_withdrawal: 'Approve Withdrawal',
      reserve_to_collateral: 'Reserve to Collateral',
      account_settle: 'Account Settle',
      j_event_claim: 'J Event Claim',
      direct_payment: 'Direct Payment',
      account_payment: 'Account Payment',
      add_delta: 'Add Delta',
      set_credit_limit: 'Set Credit Limit',
    };
    if (known[type]) return known[type];
    return type.replace(/_/g, ' ');
  }

  function toPrettyJson(value: unknown): string {
    try {
      return JSON.stringify(
        value,
        (_key, v) => {
          if (typeof v === 'bigint') return v.toString();
          if (v instanceof Map) return Object.fromEntries(v.entries());
          if (v instanceof Set) return Array.from(v.values());
          if (v instanceof Uint8Array) return Array.from(v);
          return v;
        },
        2,
      );
    } catch {
      return String(value);
    }
  }

  function toggleTokenDetails(tokenId: number): void {
    const next = new Set(expandedTokenIds);
    if (next.has(tokenId)) next.delete(tokenId);
    else next.add(tokenId);
    expandedTokenIds = next;
  }

  function formatTokenAmountSafe(tokenId: number, value: bigint): string {
    return activeXlnFunctions?.formatTokenAmount
      ? activeXlnFunctions.formatTokenAmount(tokenId, value)
      : value.toString();
  }

  function handleBackToEntity(): void {
    dispatch('back');
  }

  function openAccountWorkspace(): void {
    dispatch('goToOpenAccounts');
  }

  function handleFaucet(tokenId: number): void {
    dispatch('faucet', { counterpartyId, tokenId });
  }

  async function refreshLiveJHeight(): Promise<void> {
    if (!activeDispute) return;
    const jReplicas = activeEnv?.jReplicas;
    if (!(jReplicas instanceof Map) || jReplicas.size === 0) return;
    const activeJKey = activeEnv?.activeJurisdiction;
    const activeJReplica = activeJKey ? jReplicas.get(activeJKey) : null;
    const anyJReplica = activeJReplica ?? Array.from(jReplicas.values())[0];
    const provider = anyJReplica?.jadapter?.provider;
    if (!provider || typeof provider.getBlockNumber !== 'function') return;
    try {
      const blockNumber = Number(await provider.getBlockNumber());
      if (Number.isFinite(blockNumber)) liveJHeight = blockNumber;
    } catch {}
  }

  $: if (activeDispute) {
    void refreshLiveJHeight();
  }

  onMount(() => {
    nowTimer = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
    liveJHeightTimer = setInterval(() => {
      if (!activeDispute) return;
      void refreshLiveJHeight();
    }, 1000);
    void refreshLiveJHeight();
  });

  onDestroy(() => {
    if (nowTimer) clearInterval(nowTimer);
    if (liveJHeightTimer) clearInterval(liveJHeightTimer);
  });
</script>

<div class="account-panel">
  <div class="panel-header">
    <div class="header-row-top">
      <button class="back-button" on:click={handleBackToEntity}>←</button>

      <div class="header-identity">
        <EntityIdentity
          entityId={counterpartyId}
          name={counterpartyName}
          showAddress={true}
          compact={false}
        />
      </div>

      <div class="relay-status">
        <span class="conn-dot {relayStatus}"></span>
        {#if reconnectCountdown}
          <span class="reconnect-label">reconnect {reconnectCountdown.seconds}s</span>
        {/if}
      </div>
    </div>

    <div class="header-row-bottom">
      <span class="frame-badge">Frame #{account.currentFrame?.height ?? account.currentHeight ?? 0}</span>
      <span class="jheight-badge">J#{currentJHeight}</span>
      <span class="status-badge {uiStatus}">
        {#if uiStatus === 'disputed'}
          {uiStatusLabel} · {disputeBlocksLeft} block{disputeBlocksLeft === 1 ? '' : 's'} left
        {:else if uiStatus === 'sent'}
          {uiStatusLabel}{hasQueuedMempool ? ` · ${mempoolCount}` : ''}
        {:else}
          {uiStatusLabel}
        {/if}
      </span>
      {#if account.hankoSignature}
        <span class="trust-indicator verified" title="Cryptographically verified account state">🔒</span>
      {:else}
        <span class="trust-indicator pending" title="Awaiting cryptographic verification">⏳</span>
      {/if}
    </div>
  </div>

  <div class="panel-content">
    {#if showTokenDetails}
      {#each tokenDetails as td (td.tokenId)}
        {@const outTotal = td.derived.outOwnCredit + td.derived.outCollateral + td.derived.outPeerCredit}
        {@const inTotal = td.derived.inOwnCredit + td.derived.inCollateral + td.derived.inPeerCredit}
        {@const isExpanded = expandedTokenIds.has(td.tokenId)}
        <div class="delta-card">
          <DeltaTokenSummary
            symbol={td.tokenInfo.symbol}
            name={td.tokenInfo.name || ''}
            outAmount={activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.outCapacity) || '0'}
            inAmount={activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.inCapacity) || '0'}
            derived={td.derived}
            decimals={Number(td.tokenInfo.decimals ?? 18)}
            barHeight={12}
          >
            <svelte:fragment slot="actions">
              <button class="delta-expand" on:click={() => toggleTokenDetails(td.tokenId)}>
                {isExpanded ? 'Hide' : 'Details'}
              </button>
              <button class="delta-faucet" on:click={() => handleFaucet(td.tokenId)}>Faucet</button>
            </svelte:fragment>
          </DeltaTokenSummary>

          {#if isExpanded}
            <div class="delta-details">
              <div class="detail-grid-three detail-head">
                <span class="detail-header">Parameter</span>
                <span class="detail-header">You</span>
                <span class="detail-header">Peer</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">Delta</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.derived.delta)}</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.peerDerived.delta)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">Out capacity</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.derived.outCapacity)}</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.peerDerived.outCapacity)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">In capacity</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.derived.inCapacity)}</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.peerDerived.inCapacity)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">Out own credit (grey)</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.derived.outOwnCredit)}</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.peerDerived.outOwnCredit)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">Out collateral (green)</span>
                <span class="detail-value-cell coll">{formatTokenAmountSafe(td.tokenId, td.derived.outCollateral)}</span>
                <span class="detail-value-cell coll">{formatTokenAmountSafe(td.tokenId, td.peerDerived.outCollateral)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">Out peer credit (red)</span>
                <span class="detail-value-cell debt">{formatTokenAmountSafe(td.tokenId, td.derived.outPeerCredit)}</span>
                <span class="detail-value-cell debt">{formatTokenAmountSafe(td.tokenId, td.peerDerived.outPeerCredit)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">In own credit (red)</span>
                <span class="detail-value-cell debt">{formatTokenAmountSafe(td.tokenId, td.derived.inOwnCredit)}</span>
                <span class="detail-value-cell debt">{formatTokenAmountSafe(td.tokenId, td.peerDerived.inOwnCredit)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">In collateral (green)</span>
                <span class="detail-value-cell coll">{formatTokenAmountSafe(td.tokenId, td.derived.inCollateral)}</span>
                <span class="detail-value-cell coll">{formatTokenAmountSafe(td.tokenId, td.peerDerived.inCollateral)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">In peer credit (grey)</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.derived.inPeerCredit)}</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.peerDerived.inPeerCredit)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">Bar OUT total</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, outTotal)}</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.peerDerived.outOwnCredit + td.peerDerived.outCollateral + td.peerDerived.outPeerCredit)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">Bar IN total</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, inTotal)}</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.peerDerived.inOwnCredit + td.peerDerived.inCollateral + td.peerDerived.inPeerCredit)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">Raw collateral</span>
                <span class="detail-value-cell coll">{formatTokenAmountSafe(td.tokenId, td.delta.collateral)}</span>
                <span class="detail-value-cell coll">{formatTokenAmountSafe(td.tokenId, td.delta.collateral)}</span>
              </div>
              <div class="detail-grid-three">
                <span class="detail-label-cell">Credit limit</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.ourCreditLimit)}</span>
                <span class="detail-value-cell">{formatTokenAmountSafe(td.tokenId, td.theirCreditLimit)}</span>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    {:else}
      <div class="empty-token-state">
        {#if hasCommittedFrame}
          No active token deltas in this account.
        {:else}
          Account is opening. Deltas will appear after first committed frame.
        {/if}
      </div>
    {/if}

    <div class="proof-card">
      <div class="proof-header">
        <span>Frame #{account.currentFrame.height}</span>
        <span>{formatTimestamp(account.currentFrame.timestamp)}</span>
        {#if account.currentFrame.stateHash}
          <code title={account.currentFrame.stateHash}>{account.currentFrame.stateHash.slice(0, 16)}...</code>
          <span class="proof-ok">✓</span>
        {/if}
        {#if hasPendingConsensus}
          <span class="proof-pending">Consensus pending</span>
        {:else}
          <span class="proof-ok">Confirmed</span>
        {/if}
        {#if hasQueuedMempool}
          <span class="proof-pending">Mempool: {mempoolCount} op{mempoolCount === 1 ? '' : 's'}</span>
        {/if}
      </div>
      <details class="frame-json-details">
        <summary>Frame data (JSON)</summary>
        <pre class="frame-json">{toPrettyJson(account.currentFrame)}</pre>
      </details>
    </div>

    <div class="action-card management-card">
      <h4>Dispute</h4>
      {#if activeDispute}
        <p class="dispute-status">
          Dispute active: {disputeBlocksLeft} block{disputeBlocksLeft === 1 ? '' : 's'} left (until J#{disputeTimeoutBlock}).
        </p>
      {:else if account.status === 'disputed'}
        <p class="dispute-status queued">
          Dispute queued. Use `Accounts -> Settle -> Dispute`, then Sign & Broadcast.
        </p>
      {:else}
        <p class="dispute-status idle">No active dispute.</p>
      {/if}
      {#if account.status === 'disputed'}
        <div class="management-buttons">
          <button class="action-button open" on:click={openAccountWorkspace}>Open Accounts Workspace</button>
        </div>
      {/if}
    </div>

    <div class="section">
      <h3>Activity</h3>
      <div class="frame-history">
        {#if account.pendingFrame}
          <div class="frame-item pending">
            <div class="frame-header">
              <span class="frame-id">Pending Frame #{account.pendingFrame.height}</span>
              <span class="frame-status pending">Awaiting Consensus (not finalized)</span>
              <span class="frame-timestamp">{formatTimestamp(account.pendingFrame.timestamp)}</span>
            </div>
            {#if summarizeTxTypes(account.pendingFrame.accountTxs).length > 0}
              <div class="frame-body">
                {#each summarizeTxTypes(account.pendingFrame.accountTxs) as tx}
                  <span class="tx-chip">{txTypeLabel(tx.type)}{#if tx.count > 1} ×{tx.count}{/if}</span>
                {/each}
              </div>
            {/if}
            <details class="frame-json-details">
              <summary>Frame data (JSON)</summary>
              <pre class="frame-json">{toPrettyJson(account.pendingFrame)}</pre>
            </details>
          </div>
        {/if}

        {#if account.mempool.length > 0}
          <div class="frame-item mempool">
            <div class="frame-header">
              <span class="frame-id">Mempool Queue</span>
              <span class="frame-status mempool">{account.mempool.length} queued (not finalized)</span>
            </div>
            <div class="frame-body">
              {#each summarizeTxTypes(account.mempool) as tx}
                <span class="tx-chip">{txTypeLabel(tx.type)}{#if tx.count > 1} ×{tx.count}{/if}</span>
              {/each}
            </div>
          </div>
        {/if}

        {#if account.frameHistory && account.frameHistory.length > 0}
          <div class="historical-frames">
            {#each account.frameHistory.slice(-10).reverse() as frame}
              <div class="frame-item historical">
                <div class="frame-header">
                  <span class="frame-id">Frame #{frame.height}</span>
                  <span class="frame-status historical">Confirmed</span>
                  <span class="frame-timestamp">{formatTimestamp(frame.timestamp)}</span>
                </div>
                {#if summarizeTxTypes(frame.accountTxs).length > 0}
                  <div class="frame-body">
                    {#each summarizeTxTypes(frame.accountTxs) as tx}
                      <span class="tx-chip">{txTypeLabel(tx.type)}{#if tx.count > 1} ×{tx.count}{/if}</span>
                    {/each}
                  </div>
                {:else}
                  <div class="frame-empty">No account txs in this frame.</div>
                {/if}
                <details class="frame-json-details">
                  <summary>Frame data (JSON)</summary>
                  <pre class="frame-json">{toPrettyJson(frame)}</pre>
                </details>
              </div>
            {/each}
          </div>
        {:else if !account.pendingFrame && account.mempool.length === 0}
          <div class="no-frames">No account activity yet.</div>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .account-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #0c0a09;
  }

  .panel-header {
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid #292524;
    background: linear-gradient(180deg, #1c1917 0%, #151310 100%);
  }

  .header-row-top {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px 8px;
  }

  .header-row-bottom {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 16px 10px;
    padding-left: 52px;
  }

  .back-button {
    padding: 6px 10px;
    background: transparent;
    border: 1px solid #3f3f46;
    color: #a1a1aa;
    border-radius: 8px;
    cursor: pointer;
    font-size: 14px;
    flex-shrink: 0;
  }

  .back-button:hover {
    background: #27272a;
    border-color: #52525b;
    color: #fbbf24;
  }

  .header-identity {
    flex: 1;
    min-width: 0;
  }

  .relay-status {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .conn-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }

  .conn-dot.connected {
    background: #4ade80;
    box-shadow: 0 0 4px rgba(74, 222, 128, 0.5);
  }

  .conn-dot.reconnecting {
    background: #fbbf24;
  }

  .conn-dot.disconnected {
    background: #57534e;
  }

  .reconnect-label {
    font-size: 0.65em;
    color: #fbbf24;
    font-family: monospace;
  }

  .frame-badge,
  .jheight-badge {
    padding: 3px 10px;
    border-radius: 6px;
    font-size: 0.75em;
    font-family: 'JetBrains Mono', monospace;
  }

  .frame-badge {
    background: #18181b;
    border: 1px solid #27272a;
    color: #a1a1aa;
  }

  .jheight-badge {
    background: #18181b;
    border: 1px solid #292524;
    color: #d6d3d1;
  }

  .status-badge {
    font-size: 0.72em;
    padding: 3px 10px;
    border-radius: 6px;
    font-weight: 500;
    text-transform: uppercase;
  }

  .status-badge.ready {
    color: #4ade80;
    background: rgba(74, 222, 128, 0.1);
    border: 1px solid rgba(74, 222, 128, 0.15);
  }

  .status-badge.sent {
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.15);
  }

  .status-badge.disputed {
    color: #fb7185;
    background: rgba(244, 63, 94, 0.12);
    border: 1px solid rgba(244, 63, 94, 0.3);
  }

  .status-badge.finalized_disputed {
    color: #fca5a5;
    background: rgba(153, 27, 27, 0.24);
    border: 1px solid rgba(248, 113, 113, 0.32);
  }

  .trust-indicator {
    font-size: 0.85em;
  }

  .trust-indicator.verified {
    color: #4ade80;
  }

  .trust-indicator.pending {
    color: #a8a29e;
  }

  .panel-content {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .delta-card,
  .proof-card,
  .action-card,
  .frame-item {
    background: #18181b;
    border: 1px solid #292524;
    border-radius: 10px;
    padding: 12px;
  }

  .empty-token-state {
    background: #18181b;
    border: 1px solid #292524;
    border-radius: 10px;
    padding: 14px 12px;
    color: #9ca3af;
    font-size: 12px;
    font-style: italic;
  }

  .delta-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .delta-token {
    font-weight: 700;
    color: #f3f4f6;
  }

  .delta-brief {
    flex: 1;
    color: #a1a1aa;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
  }

  .delta-expand,
  .delta-faucet {
    border: 1px solid #3f3f46;
    background: transparent;
    color: #d1d5db;
    border-radius: 8px;
    padding: 4px 8px;
    cursor: pointer;
  }

  .delta-details {
    margin-top: 10px;
    border-top: 1px solid #292524;
    padding-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .detail-grid-three {
    display: grid;
    grid-template-columns: minmax(130px, 1fr) minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px;
    align-items: center;
  }

  .detail-head {
    color: #9ca3af;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .detail-label-cell,
  .detail-value-cell {
    font-size: 12px;
    color: #d1d5db;
    font-family: 'JetBrains Mono', monospace;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail-label-cell {
    color: #9ca3af;
    font-family: inherit;
  }

  .detail-value-cell.coll {
    color: #34d399;
  }

  .proof-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #9ca3af;
    flex-wrap: wrap;
  }

  .proof-header code {
    font-family: 'JetBrains Mono', monospace;
    color: #d1d5db;
  }

  .proof-ok {
    color: #34d399;
  }

  .proof-pending {
    color: #f59e0b;
  }

  .frame-json-details {
    margin-top: 8px;
    border-top: 1px solid #292524;
    padding-top: 6px;
  }

  .frame-json-details summary {
    cursor: pointer;
    color: #fbbf24;
    font-size: 11px;
    user-select: none;
  }

  .frame-json {
    margin: 8px 0 0;
    max-height: 260px;
    overflow: auto;
    border: 1px solid #292524;
    border-radius: 8px;
    background: #0c0a09;
    color: #d6d3d1;
    padding: 10px;
    font-size: 11px;
    line-height: 1.4;
    font-family: 'JetBrains Mono', monospace;
    white-space: pre;
  }

  .management-card h4 {
    margin: 0 0 6px;
    color: #f3f4f6;
    font-size: 13px;
  }

  .dispute-status {
    margin: 0;
    font-size: 12px;
    color: #fda4af;
  }

  .dispute-status.queued {
    color: #fb7185;
  }

  .dispute-status.idle {
    color: #9ca3af;
  }

  .management-buttons {
    margin-top: 10px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .action-button {
    border-radius: 8px;
    padding: 8px 12px;
    border: 1px solid #3f3f46;
    background: #18181b;
    color: #f3f4f6;
    cursor: pointer;
  }

  .action-button.settle {
    border-color: #f59e0b;
    color: #fbbf24;
  }

  .action-button.open {
    border-color: #52525b;
    color: #d6d3d1;
  }

  .section h3 {
    margin: 4px 0 8px;
    color: #9ca3af;
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .frame-history {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .frame-header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12px;
  }

  .frame-status.pending {
    color: #f59e0b;
  }

  .frame-status.mempool {
    color: #f97316;
  }

  .frame-status.historical {
    color: #34d399;
  }

  .frame-id,
  .frame-timestamp {
    color: #9ca3af;
  }

  .frame-body {
    margin-top: 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .tx-chip {
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px solid #3f3f46;
    background: #0c0a09;
    color: #d6d3d1;
    font-size: 11px;
    line-height: 1;
  }

  .frame-empty {
    margin-top: 8px;
    color: #6b7280;
    font-size: 11px;
  }

  .no-frames {
    border: 1px dashed #3f3f46;
    color: #78716c;
    border-radius: 8px;
    padding: 10px;
    text-align: center;
    font-size: 12px;
  }

  @media (max-width: 768px) {
    .header-row-bottom {
      padding-left: 16px;
      flex-wrap: wrap;
    }

    .delta-card-header {
      flex-wrap: wrap;
    }

    .detail-grid-three {
      grid-template-columns: 1fr;
      gap: 2px;
      padding: 4px 0;
    }

    .detail-head {
      display: none;
    }
  }
</style>
