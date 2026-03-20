<script lang="ts">
  import type { AccountMachine, AccountTx, EntityReplica, Tab } from '$lib/types/ui';
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { p2pState, xlnEnvironment, xlnFunctions } from '../../stores/xlnStore';
  import { settings } from '../../stores/settingsStore';
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
  let activityStatusFilter: 'all' | 'pending' | 'mempool' | 'confirmed' = 'all';
  let activityTypeFilter = 'all';

  type ActivityRow = {
    id: string;
    kind: 'pending' | 'mempool' | 'confirmed';
    frameLabel: string;
    timestamp: number;
    statusLabel: string;
    byLeft?: boolean;
    txs: AccountTx[];
  };

  type ActionParam = {
    label: string;
    value: string;
    tone?: 'default' | 'good' | 'warn' | 'danger';
  };

  $: iAmLeft = entityId < counterpartyId;
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
  $: pendingSecretAckInfo = (() => {
    const routes = replica?.state?.htlcRoutes;
    if (!(routes instanceof Map)) return null;
    const counterpartyNorm = String(counterpartyId || '').toLowerCase();
    let count = 0;
    let deadline = Number.POSITIVE_INFINITY;
    for (const route of routes.values()) {
      if (!route?.secretAckPending) continue;
      const inboundEntity = String(route.inboundEntity || '').toLowerCase();
      if (!inboundEntity || inboundEntity !== counterpartyNorm) continue;
      const routeDeadline = Number(route.secretAckDeadlineAt || 0);
      if (!Number.isFinite(routeDeadline) || routeDeadline <= 0) continue;
      count += 1;
      if (routeDeadline < deadline) deadline = routeDeadline;
    }
    if (count === 0 || !Number.isFinite(deadline)) return null;
    return {
      count,
      secondsLeft: Math.max(0, Math.ceil((deadline - nowMs) / 1000)),
    };
  })();

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
  $: hasCommittedFrame = Number(account.currentFrame?.height ?? account.currentHeight ?? 0) > 0;
  $: showTokenDetails = hasCommittedFrame && tokenDetails.length > 0;
  $: activityRows = (() => {
    const rows: ActivityRow[] = [];
    if (account.pendingFrame) {
      const pendingByLeft = account.pendingFrame.byLeft;
      const pendingIsYou = pendingByLeft !== undefined ? (pendingByLeft === iAmLeft) : undefined;
      rows.push({
        id: `pending-${account.pendingFrame.height}`,
        kind: 'pending',
        frameLabel: `Pending Frame #${account.pendingFrame.height}`,
        timestamp: Number(account.pendingFrame.timestamp || 0),
        statusLabel: pendingIsYou !== undefined
          ? (pendingIsYou ? `You (${iAmLeft ? 'L' : 'R'})` : `Peer (${iAmLeft ? 'R' : 'L'})`)
          : 'Pending',
        byLeft: pendingByLeft,
        txs: Array.isArray(account.pendingFrame.accountTxs) ? account.pendingFrame.accountTxs : [],
      });
    }
    if (Array.isArray(account.mempool) && account.mempool.length > 0) {
      rows.push({
        id: `mempool-${account.currentHeight}`,
        kind: 'mempool',
        frameLabel: 'Mempool Queue',
        timestamp: Number(account.currentFrame?.timestamp || 0),
        statusLabel: `${account.mempool.length} queued`,
        txs: account.mempool,
      });
    }
    const historicalFrames = Array.isArray(account.frameHistory) ? account.frameHistory.slice(-12).reverse() : [];
    for (const frame of historicalFrames) {
      const fByLeft = frame.byLeft;
      const isYou = fByLeft !== undefined ? (fByLeft === iAmLeft) : undefined;
      rows.push({
        id: `confirmed-${frame.height}`,
        kind: 'confirmed',
        frameLabel: `Frame #${frame.height}`,
        timestamp: Number(frame.timestamp || 0),
        statusLabel: isYou !== undefined
          ? (isYou ? `You (${iAmLeft ? 'L' : 'R'})` : `Peer (${iAmLeft ? 'R' : 'L'})`)
          : 'Confirmed',
        byLeft: fByLeft,
        txs: Array.isArray(frame.accountTxs) ? frame.accountTxs : [],
      });
    }
    return rows;
  })();
  $: allActivityTypes = (() => {
    const typeSet = new Set<string>();
    for (const row of activityRows) {
      for (const tx of row.txs) typeSet.add(String(tx?.type || 'unknown'));
    }
    return Array.from(typeSet.values()).sort((a, b) => txTypeLabel(a).localeCompare(txTypeLabel(b)));
  })();
  $: filteredActivityRows = activityRows
    .filter((row) => activityStatusFilter === 'all' || row.kind === activityStatusFilter)
    .map((row) => ({
      ...row,
      filteredTxs: activityTypeFilter === 'all'
        ? row.txs
        : row.txs.filter((tx) => String(tx?.type || 'unknown') === activityTypeFilter),
    }))
    .filter((row) => row.filteredTxs.length > 0);

  function formatTimestamp(ms: number): string {
    if (!ms) return '';
    const d = new Date(ms);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 } as Intl.DateTimeFormatOptions);
  }

  function txTypeLabel(type: string): string {
    const known: Record<string, string> = {
      request_collateral: 'Request Collateral',
      set_rebalance_policy: 'Set Rebalance Policy',
      reserve_to_collateral: 'Reserve to Collateral',
      account_settle: 'Account Settle',
      j_event_claim: 'J Event Claim',
      direct_payment: 'Direct Payment',
      account_payment: 'Account Payment',
      add_delta: 'Add Delta',
      set_credit_limit: 'Set Credit Limit',
    };
    if (known[type]) return known[type];
    return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function formatKeyLabel(raw: string): string {
    const known: Record<string, string> = {
      offerId: 'Offer',
      tokenId: 'Token',
      giveTokenId: 'Sell Token',
      wantTokenId: 'Buy Token',
      amount: 'Amount',
      giveAmount: 'Sell Amount',
      wantAmount: 'Buy Amount',
      priceTicks: 'Limit Price',
      minFillRatio: 'Min Fill',
      fillRatio: 'Fill',
      cancelRemainder: 'Cancel Remainder',
      requestId: 'Request ID',
      approved: 'Approved',
      counterpartyEntityId: 'Counterparty',
      jHeight: 'J Height',
      blockNumber: 'J Block',
      transactionHash: 'Tx Hash',
      workspaceVersion: 'Workspace',
      onChainNonce: 'Nonce',
      feeTokenId: 'Fee Token',
      feeAmount: 'Fee',
      events: 'Events',
      observedAt: 'Observed',
      revealBeforeHeight: 'Reveal Before',
      hashlock: 'Hashlock',
      lockId: 'Lock ID',
      timelock: 'Timelock',
      policyVersion: 'Policy Version',
      r2cRequestSoftLimit: 'R2C Request Soft Limit',
      hardLimit: 'Hard Limit',
      maxAcceptableFee: 'Max Acceptable Fee',
    };
    if (known[raw]) return known[raw];
    return raw.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  }

  function toBigIntSafe(value: unknown): bigint | null {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return BigInt(value);
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
    return null;
  }

  function toNumberSafe(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
    return null;
  }

  function toTokenIdSafe(value: unknown): number | null {
    const num = toNumberSafe(value);
    if (num === null || !Number.isFinite(num) || num <= 0) return null;
    return Math.floor(num);
  }

  function tokenLabel(tokenId: number): string {
    const tokenInfo = activeXlnFunctions?.getTokenInfo?.(tokenId);
    return tokenInfo?.symbol ? `${tokenInfo.symbol} (#${tokenId})` : `Token #${tokenId}`;
  }

  function entityLabel(entityRaw: unknown): string {
    const entity = String(entityRaw || '');
    if (!entity) return '-';
    const resolvedName = resolveEntityName(entity, activeEnv);
    const short = entity.length > 18 ? `${entity.slice(0, 10)}...${entity.slice(-4)}` : entity;
    if (resolvedName && resolvedName.toLowerCase() !== entity.toLowerCase()) return `${resolvedName} (${short})`;
    return short;
  }

  function fillRatioToPercent(ratioRaw: unknown): string {
    const ratio = toNumberSafe(ratioRaw);
    if (ratio === null) return '-';
    const clamped = Math.max(0, Math.min(65535, ratio));
    return `${((clamped / 65535) * 100).toFixed(2)}%`;
  }

  function tokenIdForAmountKey(data: Record<string, unknown>, key: string): number | null {
    if (key === 'giveAmount') return toTokenIdSafe(data['giveTokenId']);
    if (key === 'wantAmount') return toTokenIdSafe(data['wantTokenId']);
    if (key === 'feeAmount') return toTokenIdSafe(data['feeTokenId']) ?? toTokenIdSafe(data['tokenId']);
    return toTokenIdSafe(data['tokenId']);
  }

  function formatDataValue(key: string, value: unknown, data: Record<string, unknown>): ActionParam {
    const label = formatKeyLabel(key);
    if (key === 'counterpartyEntityId') {
      return { label, value: entityLabel(value) };
    }
    if (key === 'transactionHash') {
      const hash = String(value || '');
      return { label, value: hash.length > 18 ? `${hash.slice(0, 12)}...${hash.slice(-6)}` : hash || '-' };
    }
    if (key === 'offerId' || key === 'requestId' || key === 'lockId') {
      return { label, value: String(value || '-') };
    }
    if (key === 'events' && Array.isArray(value)) {
      const preview = value.slice(0, 2).map((ev) => String((ev as { type?: unknown })?.type || 'event')).join(', ');
      const suffix = value.length > 2 ? ', ...' : '';
      return { label, value: `${value.length} (${preview}${suffix})` };
    }
    if (key.endsWith('TokenId') || key === 'tokenId' || key === 'feeTokenId') {
      const tokenId = toTokenIdSafe(value);
      return { label, value: tokenId ? tokenLabel(tokenId) : '-' };
    }
    if (key === 'minFillRatio' || key === 'fillRatio') {
      return { label, value: fillRatioToPercent(value) };
    }
    if (key === 'priceTicks') {
      const ticks = toBigIntSafe(value);
      if (ticks === null) return { label, value: String(value || '-') };
      const whole = ticks / 10_000n;
      const frac = (ticks % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
      return { label, value: frac ? `${whole}.${frac}` : whole.toString() };
    }
    if (key === 'approved' || key === 'cancelRemainder') {
      const boolVal = Boolean(value);
      return { label, value: boolVal ? 'Yes' : 'No', tone: boolVal ? 'good' : 'warn' };
    }
    const big = toBigIntSafe(value);
    if (big !== null) {
      const tokenId = tokenIdForAmountKey(data, key);
      if (tokenId) return { label, value: formatTokenAmountSafe(tokenId, big) };
      return { label, value: big.toString() };
    }
    if (Array.isArray(value)) return { label, value: `${value.length} item(s)` };
    if (value && typeof value === 'object') return { label, value: `${Object.keys(value as Record<string, unknown>).length} field(s)` };
    return { label, value: String(value ?? '-') };
  }

  function getHtlcNote(data: Record<string, unknown>): string | null {
    const notes = replica?.state?.htlcNotes;
    if (!(notes instanceof Map)) return null;
    const lockId = typeof data['lockId'] === 'string' ? data['lockId'] : '';
    if (lockId) {
      const lockNote = notes.get(`lock:${lockId}`);
      if (typeof lockNote === 'string' && lockNote.trim()) return lockNote.trim();
    }
    const hashlock = typeof data['hashlock'] === 'string' ? data['hashlock'] : '';
    if (hashlock) {
      const hashNote = notes.get(`hashlock:${hashlock}`);
      if (typeof hashNote === 'string' && hashNote.trim()) return hashNote.trim();
    }
    return null;
  }

  function buildActionParams(tx: AccountTx): ActionParam[] {
    const data = (tx?.data && typeof tx.data === 'object') ? (tx.data as Record<string, unknown>) : {};
    const orderedKeys = [
      'offerId',
      'counterpartyEntityId',
      'tokenId',
      'giveTokenId',
      'wantTokenId',
      'amount',
      'giveAmount',
      'wantAmount',
      'priceTicks',
      'minFillRatio',
      'fillRatio',
      'cancelRemainder',
      'requestId',
      'approved',
      'feeTokenId',
      'feeAmount',
      'r2cRequestSoftLimit',
      'hardLimit',
      'maxAcceptableFee',
      'workspaceVersion',
      'jHeight',
      'events',
      'blockNumber',
      'transactionHash',
      'onChainNonce',
    ];
    const keys = Object.keys(data);
    const seen = new Set<string>();
    const out: ActionParam[] = [];
    for (const key of orderedKeys) {
      if (!(key in data)) continue;
      seen.add(key);
      out.push(formatDataValue(key, data[key], data));
    }
    for (const key of keys) {
      if (seen.has(key)) continue;
      out.push(formatDataValue(key, data[key], data));
    }
    if (!('description' in data)) {
      const htlcNote = getHtlcNote(data);
      if (htlcNote) out.push({ label: 'Comment', value: htlcNote });
    }
    return out;
  }

  function txKindTone(type: string): 'neutral' | 'good' | 'warn' | 'danger' {
    if (type === 'swap_resolve' || type === 'account_settle') return 'good';
    if (type === 'swap_cancel_request' || type === 'request_collateral') return 'warn';
    if (type === 'reopen_disputed') return 'danger';
    return 'neutral';
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

  function stripTrailingSymbol(rawAmount: string, rawSymbol: string): string {
    const amount = String(rawAmount || '').replace(/\s+/g, ' ').trim();
    const symbol = String(rawSymbol || '').trim();
    if (!amount || !symbol) return amount;
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return amount.replace(new RegExp(`\\s+${escaped}\\s*$`, 'i'), '').trim();
  }

  function formatTokenNumberOnly(tokenId: number, value: bigint, symbol: string): string {
    return stripTrailingSymbol(formatTokenAmountSafe(tokenId, value), symbol);
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
        {@const isExpanded = expandedTokenIds.has(td.tokenId)}
        <div class="delta-card">
          <DeltaTokenSummary
            compact={true}
            barLayout={$settings.barLayout ?? 'center'}
            symbol={td.tokenInfo.symbol}
            name={td.tokenInfo.name || ''}
            outAmount={activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.outCapacity) || '0'}
            inAmount={activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.inCapacity) || '0'}
            derived={td.derived}
            decimals={Number(td.tokenInfo.decimals ?? 18)}
            barHeight={12}
            showMetricLabels={true}
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
              <div class="detail-section">
                <h5 class="detail-section-title">Perspective Parameters</h5>
                <div class="detail-table">
                  <div class="detail-grid-three detail-head">
                    <span class="detail-header">Parameter</span>
                    <span class="detail-header detail-header-right">Out</span>
                    <span class="detail-header detail-header-right">In</span>
                  </div>
                  <div class="detail-grid-three">
                    <span class="detail-label-cell">Capacity</span>
                    <span class="detail-value-cell">{formatTokenNumberOnly(td.tokenId, td.derived.outCapacity, td.tokenInfo.symbol)}</span>
                    <span class="detail-value-cell">{formatTokenNumberOnly(td.tokenId, td.derived.inCapacity, td.tokenInfo.symbol)}</span>
                  </div>
                  <div class="detail-grid-three">
                    <span class="detail-label-cell">Credit limit</span>
                    <span class="detail-value-cell">{formatTokenNumberOnly(td.tokenId, td.derived.ownCreditLimit, td.tokenInfo.symbol)}</span>
                    <span class="detail-value-cell">{formatTokenNumberOnly(td.tokenId, td.derived.peerCreditLimit, td.tokenInfo.symbol)}</span>
                  </div>
                  <div class="detail-grid-three">
                    <span class="detail-label-cell">Own credit component</span>
                    <span class="detail-value-cell">{formatTokenNumberOnly(td.tokenId, td.derived.outOwnCredit, td.tokenInfo.symbol)}</span>
                    <span class="detail-value-cell">{formatTokenNumberOnly(td.tokenId, td.derived.inOwnCredit, td.tokenInfo.symbol)}</span>
                  </div>
                  <div class="detail-grid-three">
                    <span class="detail-label-cell">Peer credit component</span>
                    <span class="detail-value-cell debt">{formatTokenNumberOnly(td.tokenId, td.derived.outPeerCredit, td.tokenInfo.symbol)}</span>
                    <span class="detail-value-cell">{formatTokenNumberOnly(td.tokenId, td.derived.inPeerCredit, td.tokenInfo.symbol)}</span>
                  </div>
                  <div class="detail-grid-three">
                    <span class="detail-label-cell">Collateral component</span>
                    <span class="detail-value-cell coll">{formatTokenNumberOnly(td.tokenId, td.derived.outCollateral, td.tokenInfo.symbol)}</span>
                    <span class="detail-value-cell coll">{formatTokenNumberOnly(td.tokenId, td.derived.inCollateral, td.tokenInfo.symbol)}</span>
                  </div>
                  <div class="detail-grid-three">
                    <span class="detail-label-cell">Hold deduction</span>
                    <span class="detail-value-cell debt">{formatTokenNumberOnly(td.tokenId, td.derived.outTotalHold ?? 0n, td.tokenInfo.symbol)}</span>
                    <span class="detail-value-cell debt">{formatTokenNumberOnly(td.tokenId, td.derived.inTotalHold ?? 0n, td.tokenInfo.symbol)}</span>
                  </div>
                </div>
              </div>

              <div class="detail-section canonical">
                <h5 class="detail-section-title">Canonical State (Side-Neutral)</h5>
                <div class="detail-list">
                  <div class="detail-line">
                    <span class="detail-label">delta</span>
                    <span class="detail-value">{formatTokenNumberOnly(td.tokenId, (td.delta?.offdelta ?? 0n) + (td.delta?.ondelta ?? 0n), td.tokenInfo.symbol)}</span>
                  </div>
                  <div class="detail-line">
                    <span class="detail-label">offdelta</span>
                    <span class="detail-value">{formatTokenNumberOnly(td.tokenId, td.delta?.offdelta ?? 0n, td.tokenInfo.symbol)}</span>
                  </div>
                  <div class="detail-line">
                    <span class="detail-label">ondelta</span>
                    <span class="detail-value">{formatTokenNumberOnly(td.tokenId, td.delta?.ondelta ?? 0n, td.tokenInfo.symbol)}</span>
                  </div>
                </div>
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

    <div class="action-card management-card">
      <h4>Dispute</h4>
      {#if pendingSecretAckInfo}
        <p class="dispute-status queued">
          Awaiting secret ACK: {pendingSecretAckInfo.secondsLeft}s before auto-dispute start ({pendingSecretAckInfo.count} route{pendingSecretAckInfo.count === 1 ? '' : 's'}).
        </p>
      {/if}
      {#if activeDispute}
        <p class="dispute-status">
          Dispute active: {disputeBlocksLeft} block{disputeBlocksLeft === 1 ? '' : 's'} left (until J#{disputeTimeoutBlock}).
        </p>
      {:else if account.status === 'disputed'}
        <p class="dispute-status queued">
          Dispute queued. Open the batch panel and broadcast the pending dispute batch.
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
      <div class="activity-filters">
        <label>
          Status
          <select bind:value={activityStatusFilter}>
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="mempool">Mempool</option>
            <option value="confirmed">Confirmed</option>
          </select>
        </label>
        <label>
          Action
          <select bind:value={activityTypeFilter}>
            <option value="all">All</option>
            {#each allActivityTypes as type}
              <option value={type}>{txTypeLabel(type)}</option>
            {/each}
          </select>
        </label>
      </div>
      <div class="frame-history">
        {#if filteredActivityRows.length > 0}
          {#each filteredActivityRows as row (row.id)}
            <div class="frame-item {row.kind} {row.byLeft !== undefined ? (row.byLeft === iAmLeft ? 'author-you' : 'author-peer') : ''}">
              <div class="frame-header">
                <span class="frame-id">{row.frameLabel}</span>
                <span class="frame-status {row.kind} {row.byLeft !== undefined ? (row.byLeft === iAmLeft ? 'is-you' : 'is-peer') : ''}">{row.statusLabel}</span>
                <span class="frame-timestamp">{formatTimestamp(row.timestamp)}</span>
              </div>
              <div class="tx-cards">
                {#each row.filteredTxs as tx, txIndex (`${row.id}-${txIndex}-${tx.type}`)}
                  <article class="tx-action-card">
                    <div class="tx-action-head">
                      <span class="tx-type tone-{txKindTone(tx.type)}">{txTypeLabel(tx.type)}</span>
                      <span class="tx-idx">#{txIndex + 1}</span>
                    </div>
                    <div class="tx-params">
                      {#each buildActionParams(tx) as param (`${param.label}-${param.value}`)}
                        <div class="tx-param">
                          <span class="tx-param-label">{param.label}</span>
                          <span class="tx-param-value tone-{param.tone || 'default'}">{param.value}</span>
                        </div>
                      {/each}
                    </div>
                  </article>
                {/each}
              </div>
            </div>
          {/each}
        {:else}
          <div class="no-frames">No account activity yet.</div>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .account-panel {
    min-height: 100%;
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

  .delta-expand,
  .delta-faucet {
    border: 1px solid #3f3f46;
    background: transparent;
    color: #d1d5db;
    border-radius: 8px;
    padding: 5px 10px;
    cursor: pointer;
    font-size: 11px;
    line-height: 1;
  }

  .delta-details {
    margin-top: 8px;
    border-top: 1px solid #292524;
    padding-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .detail-section {
    border: 1px solid rgba(63, 63, 70, 0.32);
    border-radius: 10px;
    background: rgba(24, 24, 27, 0.55);
    padding: 10px;
  }

  .detail-section.canonical {
    border-color: rgba(120, 113, 108, 0.45);
    background: rgba(20, 20, 22, 0.72);
  }

  .detail-section-title {
    margin: 0 0 8px;
    color: #a1a1aa;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
  }

  .detail-table {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .detail-grid-three {
    display: grid;
    grid-template-columns: minmax(180px, 240px) minmax(140px, 1fr) minmax(140px, 1fr);
    gap: 8px;
    align-items: center;
    border: 1px solid rgba(63, 63, 70, 0.28);
    border-radius: 8px;
    background: rgba(12, 10, 9, 0.6);
    padding: 7px 9px;
  }

  .detail-head {
    margin-bottom: 4px;
    border-style: dashed;
    background: rgba(24, 24, 27, 0.9);
  }

  .detail-header {
    color: #9ca3af;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    line-height: 1;
    font-weight: 700;
  }

  .detail-header-right {
    text-align: right;
  }

  .detail-label,
  .detail-label-cell {
    color: #9ca3af;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    line-height: 1;
  }

  .detail-value,
  .detail-value-cell {
    color: #e7e5e4;
    font-size: 14px;
    font-family: 'JetBrains Mono', monospace;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .detail-value-cell {
    text-align: right;
  }

  .detail-value.coll {
    color: #34d399;
  }

  .detail-value-cell.coll {
    color: #34d399;
  }

  .detail-value.debt {
    color: #fb7185;
  }

  .detail-value-cell.debt {
    color: #fb7185;
  }

  .detail-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .detail-line {
    border: 1px solid rgba(63, 63, 70, 0.28);
    border-radius: 8px;
    background: rgba(12, 10, 9, 0.6);
    padding: 7px 9px;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
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

  .tx-cards {
    margin-top: 8px;
    display: grid;
    gap: 8px;
  }

  .tx-action-card {
    background: rgba(24, 24, 27, 0.85);
    border: 1px solid #34302c;
    border-radius: 10px;
    padding: 10px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
  }

  .tx-action-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }

  .tx-type {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    border: 1px solid #3f3f46;
    padding: 3px 9px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: #e7e5e4;
  }

  .tx-type.tone-neutral {
    border-color: #44403c;
    color: #e7e5e4;
    background: rgba(68, 64, 60, 0.2);
  }

  .tx-type.tone-good {
    border-color: rgba(16, 185, 129, 0.4);
    color: #86efac;
    background: rgba(16, 185, 129, 0.12);
  }

  .tx-type.tone-warn {
    border-color: rgba(245, 158, 11, 0.45);
    color: #fbbf24;
    background: rgba(245, 158, 11, 0.13);
  }

  .tx-type.tone-danger {
    border-color: rgba(244, 63, 94, 0.5);
    color: #fda4af;
    background: rgba(244, 63, 94, 0.16);
  }

  .tx-idx {
    color: #78716c;
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
  }

  .tx-params {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 8px;
  }

  .tx-param {
    border: 1px solid #312d2a;
    border-radius: 8px;
    padding: 6px 8px;
    background: rgba(12, 10, 9, 0.65);
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .tx-param-label {
    color: #9ca3af;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    line-height: 1;
  }

  .tx-param-value {
    color: #e7e5e4;
    font-size: 12px;
    font-family: 'JetBrains Mono', monospace;
    line-height: 1.25;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tx-param-value.tone-good {
    color: #86efac;
  }

  .tx-param-value.tone-warn {
    color: #fbbf24;
  }

  .tx-param-value.tone-danger {
    color: #fda4af;
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

  .activity-filters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
    margin-bottom: 10px;
  }

  .activity-filters label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: #a8a29e;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .activity-filters select {
    border: 1px solid #3f3f46;
    border-radius: 8px;
    background: #111113;
    color: #e7e5e4;
    font-size: 12px;
    padding: 7px 8px;
  }

  .activity-filters select:focus-visible {
    outline: 1px solid rgba(251, 191, 36, 0.7);
    outline-offset: 1px;
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

  .frame-status.confirmed {
    color: #34d399;
  }

  .frame-status.is-you {
    color: #60a5fa;
  }

  .frame-status.is-peer {
    color: #c084fc;
  }

  .frame-item.author-you {
    border-left: 3px solid #60a5fa;
  }

  .frame-item.author-peer {
    border-left: 3px solid #c084fc;
  }

  .frame-id,
  .frame-timestamp {
    color: #9ca3af;
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

    .detail-grid-three {
      grid-template-columns: 1fr;
      gap: 3px;
    }

    .detail-head {
      display: none;
    }

    .detail-value-cell {
      text-align: left;
    }

    .tx-params {
      grid-template-columns: 1fr;
    }
  }
</style>
