<script lang="ts">
  import type { AccountMachine, AccountTx, EntityReplica } from '$lib/types/ui';
  import type { Env, EnvSnapshot } from '@xln/runtime/xln-api';
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { p2pState, xlnFunctions } from '../../stores/xlnStore';
  import { settings } from '../../stores/settingsStore';
  import EntityIdentity from '../shared/EntityIdentity.svelte';
  import DeltaTokenSummary from './shared/DeltaTokenSummary.svelte';
  import AccountTokenDetails from './shared/AccountTokenDetails.svelte';
  import { buildAccountTokenDetails, isAccountLeftPerspective } from './shared/account-token-details';
  import { resolveEntityName } from '$lib/utils/entityNaming';

  export let account: AccountMachine;
  export let counterpartyId: string;
  export let entityId: string;
  export let replica: EntityReplica | null = null;
  export let env: Env | EnvSnapshot;

  const dispatch = createEventDispatcher();

  $: activeXlnFunctions = $xlnFunctions;
  $: activeEnv = env;

  let expandedTokenIds = new Set<number>();
  let nowMs = Date.now();
  let mounted = false;
  let nowTimer: ReturnType<typeof setInterval> | null = null;
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

  $: iAmLeft = isAccountLeftPerspective(entityId, account);
  $: activeDispute = account.activeDispute ?? null;
  $: disputeTimeoutBlock = Number(activeDispute?.disputeTimeout ?? 0);
  $: currentJHeight = Math.max(
    Number(account.lastFinalizedJHeight ?? 0),
    Number(replica?.state?.lastFinalizedJHeight ?? 0),
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

  $: tokenDetails = buildAccountTokenDetails(account, entityId, activeXlnFunctions);
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
        frameLabel: `Draft A#${account.pendingFrame.height}`,
        timestamp: Number(account.pendingFrame.timestamp || 0),
        statusLabel: pendingIsYou !== undefined
          ? (pendingIsYou ? `You (${iAmLeft ? 'L' : 'R'})` : `Counterparty (${iAmLeft ? 'R' : 'L'})`)
          : 'Draft',
        ...(pendingByLeft !== undefined ? { byLeft: pendingByLeft } : {}),
        txs: Array.isArray(account.pendingFrame.accountTxs) ? account.pendingFrame.accountTxs : [],
      });
    }
    if (Array.isArray(account.mempool) && account.mempool.length > 0) {
      rows.push({
        id: `mempool-${account.currentHeight}`,
        kind: 'mempool',
        frameLabel: 'Queued Broadcast',
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
        frameLabel: `A#${frame.height}`,
        timestamp: Number(frame.timestamp || 0),
        statusLabel: isYou !== undefined
          ? (isYou ? `You (${iAmLeft ? 'L' : 'R'})` : `Counterparty (${iAmLeft ? 'R' : 'L'})`)
          : 'Confirmed',
        ...(fByLeft !== undefined ? { byLeft: fByLeft } : {}),
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
      fromEntityId: 'From',
      toEntityId: 'To',
      jHeight: 'J Height',
      blockNumber: 'J Block',
      jBlockHash: 'J Block Hash',
      transactionHash: 'Tx Hash',
      workspaceVersion: 'Workspace',
      onChainNonce: 'Nonce',
      feeTokenId: 'Fee Token',
      feeAmount: 'Fee',
      events: 'Events',
      observedAt: 'Observed',
      description: 'Description',
      route: 'Route',
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
    if (key === 'counterpartyEntityId' || key === 'fromEntityId' || key === 'toEntityId') {
      return { label, value: entityLabel(value) };
    }
    if (key === 'transactionHash' || key === 'jBlockHash') {
      const hash = String(value || '');
      return { label, value: hash.length > 18 ? `${hash.slice(0, 12)}...${hash.slice(-6)}` : hash || '-' };
    }
    if (key === 'route' && Array.isArray(value)) {
      const path = value
        .map((hop) => String(hop || '').trim())
        .filter(Boolean)
        .map((hop) => entityLabel(hop));
      return { label, value: path.length > 0 ? path.join(' → ') : '-' };
    }
    if (key === 'observedAt') {
      const observedAt = toNumberSafe(value);
      if (observedAt === null || observedAt <= 0) return { label, value: '-' };
      return {
        label,
        value: new Date(observedAt).toLocaleString(undefined, {
          month: 'short',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      };
    }
    if (key === 'description') {
      const text = String(value || '').trim();
      return { label, value: text || '-' };
    }
    if (key === 'offerId' || key === 'requestId' || key === 'lockId') {
      return { label, value: String(value || '-') };
    }
    if (key === 'events' && Array.isArray(value)) {
      const preview = value
        .slice(0, 3)
        .map((ev) => String((ev as { type?: unknown })?.type || 'event').replace(/_/g, ' '))
        .join(', ');
      const suffix = value.length > 3 ? ', ...' : '';
      return { label, value: `${value.length} · ${preview}${suffix}` };
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
      'fromEntityId',
      'toEntityId',
      'tokenId',
      'giveTokenId',
      'wantTokenId',
      'amount',
      'giveAmount',
      'wantAmount',
      'description',
      'route',
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
      'jBlockHash',
      'observedAt',
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

  function handleBackToEntity(): void {
    dispatch('back');
  }

  function openAccountWorkspace(): void {
    dispatch('goToOpenAccounts');
  }

  function handleFaucet(tokenId: number): void {
    dispatch('faucet', { counterpartyId, tokenId });
  }

  function clearNowTimer(): void {
    if (nowTimer) {
      clearInterval(nowTimer);
      nowTimer = null;
    }
  }

  function syncLiveTimers(): void {
    const needNowTimer = Boolean(activeDispute || pendingSecretAckInfo || $p2pState.reconnect);
    if (needNowTimer) {
      if (!nowTimer) {
        nowMs = Date.now();
        nowTimer = setInterval(() => {
          nowMs = Date.now();
        }, 1000);
      }
    } else {
      clearNowTimer();
    }
  }

  $: if (mounted) {
    syncLiveTimers();
  }

  onMount(() => {
    mounted = true;
    syncLiveTimers();
  });

  onDestroy(() => {
    mounted = false;
    clearNowTimer();
  });
</script>

<div class="account-panel">
  <div class="panel-header">
    <div class="header-row-top">
      <button class="back-button" data-testid="account-panel-back" on:click={handleBackToEntity}>← Back to Entity</button>

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
      </div>
    </div>
  </div>

  <div class="panel-content">
    {#if showTokenDetails}
      {#each tokenDetails as td (td.tokenId)}
        {@const isExpanded = expandedTokenIds.has(td.tokenId)}
        <div class="delta-card">
          <div class="delta-card-toggle">
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
              expanded={isExpanded}
              on:bartoggle={() => toggleTokenDetails(td.tokenId)}
            >
              <svelte:fragment slot="actions">
                <button class="delta-faucet" on:click|stopPropagation={() => handleFaucet(td.tokenId)}>Faucet</button>
              </svelte:fragment>
            </DeltaTokenSummary>
          </div>

          {#if isExpanded}
            <AccountTokenDetails detail={td} formatTokenAmount={activeXlnFunctions?.formatTokenAmount ?? null} />
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
          <button class="action-button open" data-testid="account-panel-open-accounts-workspace" on:click={openAccountWorkspace}>Open Accounts Workspace</button>
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
    --account-panel-bg: color-mix(in srgb, var(--theme-background, #09090b) 100%, transparent);
    --account-panel-surface: color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 98%, transparent);
    --account-panel-surface-hover: color-mix(in srgb, var(--theme-surface-hover, var(--theme-card-bg, #1c1c20)) 96%, transparent);
    --account-panel-border: color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 88%, transparent);
    --account-panel-border-strong: color-mix(in srgb, var(--theme-card-hover-border, var(--theme-border, #27272a)) 82%, transparent);
    --account-panel-text: var(--theme-text-primary, #e4e4e7);
    --account-panel-text-secondary: var(--theme-text-secondary, #a1a1aa);
    --account-panel-text-muted: var(--theme-text-muted, #71717a);
    --account-panel-accent: var(--theme-accent, #fbbf24);
    --account-panel-credit: var(--theme-credit, #4ade80);
    --account-panel-debit: var(--theme-debit, #f43f5e);
    display: flex;
    flex-direction: column;
    background: var(--account-panel-bg);
    color: var(--account-panel-text);
  }

  .panel-header {
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid var(--account-panel-border);
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--theme-card-bg, var(--theme-header-bg, #151316)) 98%, var(--theme-background, #09090b)) 0%,
      color-mix(in srgb, var(--theme-background, #09090b) 100%, transparent) 100%
    );
    box-shadow: 0 12px 28px color-mix(in srgb, var(--theme-background, #09090b) 7%, transparent);
  }

  .header-row-top {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px 8px;
  }

  .back-button {
    padding: 6px 10px;
    background: transparent;
    border: 1px solid var(--account-panel-border);
    color: var(--account-panel-text-secondary);
    border-radius: 8px;
    cursor: pointer;
    font-size: 14px;
    flex-shrink: 0;
  }

  .back-button:hover {
    background: var(--account-panel-surface-hover);
    border-color: var(--account-panel-border-strong);
    color: var(--account-panel-accent);
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
    background: var(--account-panel-credit);
    box-shadow: 0 0 4px color-mix(in srgb, var(--account-panel-credit) 50%, transparent);
  }

  .conn-dot.reconnecting {
    background: var(--account-panel-accent);
  }

  .conn-dot.disconnected {
    background: color-mix(in srgb, var(--account-panel-text-muted) 58%, transparent);
  }

  .panel-content {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    overflow-x: hidden;
  }

  .delta-card,
  .proof-card,
  .action-card,
  .frame-item {
    background: var(--account-panel-surface);
    border: 1px solid var(--account-panel-border);
    border-radius: 10px;
    padding: 12px;
    box-shadow: 0 10px 24px color-mix(in srgb, var(--theme-background, #09090b) 7%, transparent);
  }

  .empty-token-state {
    background: var(--account-panel-surface);
    border: 1px solid var(--account-panel-border);
    border-radius: 10px;
    padding: 14px 12px;
    color: var(--account-panel-text-secondary);
    font-size: 12px;
    font-style: italic;
  }

  .delta-card-toggle {
    border-radius: 10px;
    cursor: default;
  }

  .delta-card-toggle:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--account-panel-accent) 70%, white 30%);
    outline-offset: 3px;
  }

  .delta-faucet {
    border: 1px solid var(--account-panel-border);
    background: transparent;
    color: var(--account-panel-text);
    border-radius: 8px;
    padding: 5px 10px;
    cursor: pointer;
    font-size: 11px;
    line-height: 1;
  }

  .delta-details {
    margin-top: 8px;
    border-top: 1px solid var(--account-panel-border);
    padding-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .detail-section {
    border: 1px solid color-mix(in srgb, var(--account-panel-border) 68%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--account-panel-surface) 72%, transparent);
    padding: 10px;
  }

  .detail-section.canonical {
    border-color: color-mix(in srgb, var(--account-panel-border-strong) 72%, transparent);
    background: color-mix(in srgb, var(--account-panel-surface-hover) 84%, transparent);
  }

  .detail-section-title {
    margin: 0 0 8px;
    color: var(--account-panel-text-secondary);
    font-size: 12px;
    text-transform: none;
    letter-spacing: 0.01em;
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
    border: 1px solid color-mix(in srgb, var(--account-panel-border) 62%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 68%, transparent);
    padding: 7px 9px;
  }

  .detail-head {
    margin-bottom: 4px;
    border-style: dashed;
    background: color-mix(in srgb, var(--account-panel-surface) 90%, transparent);
  }

  .detail-header {
    color: var(--account-panel-text-secondary);
    font-size: 10px;
    text-transform: none;
    letter-spacing: 0.01em;
    line-height: 1;
    font-weight: 700;
  }

  .detail-header-right {
    text-align: right;
  }

  .detail-label,
  .detail-label-cell {
    color: var(--account-panel-text-secondary);
    font-size: 11px;
    text-transform: none;
    letter-spacing: 0.01em;
    line-height: 1;
  }

  .detail-value,
  .detail-value-cell {
    color: var(--account-panel-text);
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
    color: var(--account-panel-credit);
  }

  .detail-value-cell.coll {
    color: var(--account-panel-credit);
  }

  .detail-value.debt {
    color: color-mix(in srgb, var(--account-panel-debit) 72%, white 28%);
  }

  .detail-value-cell.debt {
    color: color-mix(in srgb, var(--account-panel-debit) 72%, white 28%);
  }

  .detail-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .detail-line {
    border: 1px solid color-mix(in srgb, var(--account-panel-border) 62%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 68%, transparent);
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
    color: var(--account-panel-text-secondary);
    flex-wrap: wrap;
  }

  .proof-ok {
    color: var(--account-panel-credit);
  }

  .proof-pending {
    color: var(--account-panel-accent);
  }

  .tx-cards {
    margin-top: 8px;
    display: grid;
    gap: 8px;
  }

  .tx-action-card {
    background: color-mix(in srgb, var(--account-panel-surface-hover) 88%, transparent);
    border: 1px solid var(--account-panel-border);
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
    border: 1px solid var(--account-panel-border);
    padding: 3px 9px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--account-panel-text);
  }

  .tx-type.tone-neutral {
    border-color: var(--account-panel-border-strong);
    color: var(--account-panel-text);
    background: rgba(68, 64, 60, 0.2);
  }

  .tx-type.tone-good {
    border-color: rgba(16, 185, 129, 0.4);
    color: var(--account-panel-credit);
    background: color-mix(in srgb, var(--account-panel-credit) 12%, transparent);
  }

  .tx-type.tone-warn {
    border-color: rgba(245, 158, 11, 0.45);
    color: var(--account-panel-accent);
    background: rgba(245, 158, 11, 0.13);
  }

  .tx-type.tone-danger {
    border-color: rgba(244, 63, 94, 0.5);
    color: color-mix(in srgb, var(--account-panel-debit) 72%, white 28%);
    background: color-mix(in srgb, var(--account-panel-debit) 14%, transparent);
  }

  .tx-idx {
    color: var(--account-panel-text-muted);
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
  }

  .tx-params {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 8px;
  }

  .tx-param {
    border: 1px solid color-mix(in srgb, var(--account-panel-border) 66%, transparent);
    border-radius: 8px;
    padding: 6px 8px;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 72%, transparent);
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .tx-param-label {
    color: var(--account-panel-text-secondary);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    line-height: 1;
  }

  .tx-param-value {
    color: var(--account-panel-text);
    font-size: 12px;
    font-family: 'JetBrains Mono', monospace;
    line-height: 1.25;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tx-param-value.tone-good {
    color: var(--account-panel-credit);
  }

  .tx-param-value.tone-warn {
    color: var(--account-panel-accent);
  }

  .tx-param-value.tone-danger {
    color: color-mix(in srgb, var(--account-panel-debit) 72%, white 28%);
  }

  .management-card h4 {
    margin: 0 0 6px;
    color: var(--account-panel-text);
    font-size: 13px;
  }

  .dispute-status {
    margin: 0;
    font-size: 12px;
    color: color-mix(in srgb, var(--account-panel-debit) 68%, white 32%);
  }

  .dispute-status.queued {
    color: color-mix(in srgb, var(--account-panel-debit) 78%, white 22%);
  }

  .dispute-status.idle {
    color: var(--account-panel-text-secondary);
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
    border: 1px solid var(--account-panel-border);
    background: var(--account-panel-surface);
    color: var(--account-panel-text);
    cursor: pointer;
  }

  .action-button.settle {
    border-color: color-mix(in srgb, var(--account-panel-accent) 60%, transparent);
    color: var(--account-panel-accent);
  }

  .action-button.open {
    border-color: var(--account-panel-border-strong);
    color: var(--account-panel-text-secondary);
  }

  .section h3 {
    margin: 4px 0 8px;
    color: var(--account-panel-text-secondary);
    font-size: 0.95em;
    text-transform: none;
    letter-spacing: 0.01em;
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
    color: var(--account-panel-text-secondary);
    font-size: 11px;
    text-transform: none;
    letter-spacing: 0.01em;
  }

  .activity-filters select {
    border: 1px solid var(--account-panel-border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 90%, transparent);
    color: var(--account-panel-text);
    font-size: 12px;
    padding: 7px 8px;
  }

  .activity-filters select:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--account-panel-accent) 70%, transparent);
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
    color: var(--account-panel-accent);
  }

  .frame-status.mempool {
    color: color-mix(in srgb, var(--account-panel-accent) 78%, #b45309);
  }

  .frame-status.historical {
    color: var(--account-panel-credit);
  }

  .frame-status.confirmed {
    color: var(--account-panel-credit);
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
    color: var(--account-panel-text-secondary);
  }

  .frame-empty {
    margin-top: 8px;
    color: var(--account-panel-text-muted);
    font-size: 11px;
  }

  .no-frames {
    border: 1px dashed var(--account-panel-border);
    color: var(--account-panel-text-muted);
    border-radius: 8px;
    padding: 10px;
    text-align: center;
    font-size: 12px;
  }

  @media (max-width: 768px) {
    .header-row-top {
      flex-wrap: wrap;
      align-items: flex-start;
    }

    .panel-content {
      padding: 14px;
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
