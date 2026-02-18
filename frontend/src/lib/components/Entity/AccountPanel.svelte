<script lang="ts">
  import type { AccountMachine } from '$lib/types/ui';
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { getXLN, xlnEnvironment, xlnFunctions, error, p2pState } from '../../stores/xlnStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import type { EntityReplica, Tab } from '$lib/types/ui';
  import BigIntInput from '../Common/BigIntInput.svelte';
  import EntityIdentity from '../shared/EntityIdentity.svelte';
  import PaymentForm from './PaymentForm.svelte';
  import CreditForm from './CreditForm.svelte';
  import CollateralForm from './CollateralForm.svelte';
  import SwapPanel from './SwapPanel.svelte';

  // Get environment from context (for /view route) or use global stores (for / route)
  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;

  // Extract the stores from entityEnv (or use global stores as fallback)
  const contextXlnFunctions = entityEnv?.xlnFunctions;
  const contextEnv = entityEnv?.env;

  // Use context stores if available, otherwise fall back to global
  $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;
  $: activeEnv = contextEnv ? $contextEnv : $xlnEnvironment;

  // FINTECH-SAFE: Never return "N/A" - fail fast if data is corrupted
  // Handles BigInt by converting to Number first
  function safeFixed(value: any, decimals: number = 4): string {
    if (value == null) {
      console.error('FINTECH-SAFETY: Attempted to format null value:', value);
      throw new Error('FINTECH-SAFETY: Invalid numeric value - financial data corrupted');
    }
    // Convert BigInt to Number first, then check for NaN
    const numValue = Number(value);
    if (isNaN(numValue)) {
      console.error('FINTECH-SAFETY: Attempted to format NaN value:', value);
      throw new Error('FINTECH-SAFETY: Invalid numeric value - financial data corrupted');
    }
    return numValue.toFixed(decimals);
  }

  // Simple timestamp formatting
  function formatTimestamp(ms: number): string {
    return new Date(ms).toLocaleTimeString();
  }


  export let account: AccountMachine;
  export let counterpartyId: string;
  export let entityId: string;
  export let replica: EntityReplica | null = null;
  export let tab: Tab | null = null;
  $: formSignerId = tab?.signerId || replica?.state?.config?.validators?.[0] || entityId;

  // Tab state
  type AccountTab = 'activity' | 'actions' | 'settle';
  let activeAccountTab: AccountTab = 'activity';

  // Pending count for Activity badge
  $: pendingCount = (account.mempool?.length || 0) + (account.pendingFrame ? 1 : 0);

  const dispatch = createEventDispatcher();

  // Handle back to entity navigation
  function handleBackToEntity() {
    dispatch('back');
  }

  // Settlement form state
  let selectedTokenId = 1;

  // Settlement workspace state
  let settleOpType: 'r2c' | 'c2r' | 'r2r' | 'forgive' = 'r2c';
  let settleTokenId = 1;
  let settleAmountBigInt = 0n;
  let pendingOps: Array<{ type: 'r2c' | 'c2r' | 'r2r' | 'forgive'; tokenId: number; amount?: bigint }> = [];
  let proposeMemo = '';
  let settleInFlight = false;

  // Reactive workspace state
  $: workspace = account.settlementWorkspace;
  $: wsOps = workspace?.ops ?? [];
  $: wsStatus = workspace?.status ?? null;
  $: iAmLeft = entityId < counterpartyId;
  $: iAmProposer = workspace ? workspace.lastModifiedByLeft === iAmLeft : false;
  $: myHanko = workspace ? (iAmLeft ? workspace.leftHanko : workspace.rightHanko) : null;
  $: theirHanko = workspace ? (iAmLeft ? workspace.rightHanko : workspace.leftHanko) : null;
  // Status-gated actions: only allow in correct lifecycle phase
  $: canApprove = workspace && wsStatus === 'awaiting_counterparty' && !iAmProposer && !myHanko;
  $: canExecute = workspace && wsStatus === 'ready_to_submit' && theirHanko && workspace.executorIsLeft === iAmLeft;
  $: canUpdate = workspace && (wsStatus === 'draft' || wsStatus === 'awaiting_counterparty') && iAmProposer && !myHanko && !theirHanko;

  // Settlement preview: compute ghost bar from pendingOps
  // Shows post-settlement state for each token affected by pending ops
  $: settlePreview = (() => {
    if (pendingOps.length === 0 || !activeXlnFunctions?.deriveDelta) return [];
    const affectedTokens = new Set(pendingOps.map(op => op.tokenId));
    return tokenDetails
      .filter(td => affectedTokens.has(td.tokenId))
      .map(td => {
        // Clone delta and apply ops
        const d = td.delta;
        let collateral = d.collateral;
        let ondelta = d.ondelta;
        for (const op of pendingOps) {
          if (op.tokenId !== td.tokenId) continue;
          const amt = op.amount ?? 0n;
          if (op.type === 'r2c') {
            collateral += amt;
            if (iAmLeft) ondelta += amt;
          } else if (op.type === 'c2r') {
            collateral -= amt;
            if (iAmLeft) ondelta -= amt;
          }
          // r2r/forgive: no collateral/ondelta change in preview
        }
        const previewDelta = { ...d, collateral, ondelta };
        const previewDerived = activeXlnFunctions!.deriveDelta(previewDelta, iAmLeft);
        return {
          tokenId: td.tokenId,
          tokenInfo: td.tokenInfo,
          current: td.derived,
          preview: previewDerived,
          collateralDiff: collateral - d.collateral,
          ondeltaDiff: ondelta - d.ondelta,
        };
      });
  })();
  let nowMs = Date.now();
  let nowTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    nowTimer = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
  });

  onDestroy(() => {
    if (nowTimer) clearInterval(nowTimer);
  });

  // Auto-set defaults for faster testing
  $: {
    if (tokenDetails.length > 0 && selectedTokenId === 1 && !tokenDetails.find(td => td.tokenId === 1)) {
      selectedTokenId = tokenDetails[0]!.tokenId;
    }
  }

  // Get entity name from gossip
  function getEntityName(id: string): string {
    const envData = contextEnv ? $contextEnv : $xlnEnvironment;
    if (envData?.gossip) {
      const profiles = typeof envData.gossip.getProfiles === 'function' ? envData.gossip.getProfiles() : (envData.gossip.profiles || []);
      const profile = profiles.find((p: any) => p.entityId === id);
      if (profile?.metadata?.name) return profile.metadata.name;
    }
    return '';
  }

  $: counterpartyName = getEntityName(counterpartyId);

  // Hub detection for faucet button
  $: isHub = (() => {
    const envData = contextEnv ? $contextEnv : $xlnEnvironment;
    if (!envData?.gossip) return false;
    const profiles = typeof envData.gossip.getProfiles === 'function' ? envData.gossip.getProfiles() : (envData.gossip.profiles || []);
    const profile = profiles.find((p: any) => String(p?.entityId || '').toLowerCase() === String(counterpartyId).toLowerCase());
    return !!(profile?.metadata?.isHub === true || (Array.isArray(profile?.capabilities) && profile.capabilities.includes('hub')));
  })();

  function handleFaucet(tokenId: number) {
    dispatch('faucet', { counterpartyId, tokenId });
  }

  // P2P connection state for header display
  $: reconnectCountdown = (() => {
    if (!$p2pState.reconnect) return null;
    const remaining = Math.max(0, Math.ceil(($p2pState.reconnect.nextAt - nowMs) / 1000));
    return { seconds: remaining, attempt: $p2pState.reconnect.attempt };
  })();

  $: relayStatus = $p2pState.connected ? 'connected' : reconnectCountdown ? 'reconnecting' : 'disconnected';

  // XLN functions accessed through $xlnEnvironment.xln (attached in xlnStore)

  $: tokenDetails = Array.from(account.deltas?.entries() || []).map(([tokenId, delta]) => {
    if (!activeXlnFunctions?.deriveDelta) {
      return {
        tokenId,
        delta,
        derived: {
          delta: 0n,
          totalCapacity: 0n,
          inCapacity: 0n,
          outCapacity: 0n,
          ascii: '[loading...]'
        },
        tokenInfo: { symbol: `TKN${tokenId}`, color: '#999', name: `Token ${tokenId}`, decimals: 18 },
        ourCreditLimit: 0n,
        theirCreditLimit: 0n,
        ourCollateral: 0n
      };
    }

    const derived = activeXlnFunctions.deriveDelta(delta, iAmLeft);
    const tokenInfo = activeXlnFunctions?.getTokenInfo?.(tokenId) || {
      symbol: `TKN${tokenId}`,
      color: '#999',
      name: `Token ${tokenId}`,
      decimals: 18
    };

    // Credit limits: orientation depends on which side we are
    const ourCreditLimit = iAmLeft ? delta.leftCreditLimit : delta.rightCreditLimit;
    const theirCreditLimit = iAmLeft ? delta.rightCreditLimit : delta.leftCreditLimit;

    return {
      tokenId,
      tokenInfo,
      delta,
      derived,
      ourCreditLimit,
      theirCreditLimit,
      ourCollateral: delta.collateral,
    };
  });

  function addSettleOp() {
    if (settleOpType === 'forgive') {
      pendingOps = [...pendingOps, { type: 'forgive', tokenId: settleTokenId }];
    } else {
      if (settleAmountBigInt <= 0n) return;
      pendingOps = [...pendingOps, { type: settleOpType, tokenId: settleTokenId, amount: settleAmountBigInt }];
      settleAmountBigInt = 0n;
    }
  }

  function removeSettleOp(index: number) {
    pendingOps = pendingOps.filter((_, i) => i !== index);
  }

  async function settlePropose() {
    if (pendingOps.length === 0 || settleInFlight) return;
    settleInFlight = true;
    try {
      const xln = await getXLN();
      const env = activeEnv;
      if (!env) throw new Error('Environment not ready');

      const proposerId = activeXlnFunctions!.resolveEntityProposerId(env, entityId, 'settle-propose');
      xln.enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [{
        entityId, signerId: proposerId,
        entityTxs: [{ type: 'settle_propose', data: {
          counterpartyEntityId: counterpartyId,
          ops: pendingOps,
          memo: proposeMemo || undefined,
        }}]
      }]});
      console.log('✅ Settlement proposed');
      pendingOps = [];
      proposeMemo = '';
    } catch (err: any) {
      console.error('Failed to propose settlement:', err);
      error.set(`Settle propose failed: ${err?.message || 'Unknown error'}`);
    } finally {
      settleInFlight = false;
    }
  }

  async function settleUpdate() {
    if (pendingOps.length === 0 || settleInFlight) return;
    settleInFlight = true;
    try {
      const xln = await getXLN();
      const env = activeEnv;
      if (!env) throw new Error('Environment not ready');

      const proposerId = activeXlnFunctions!.resolveEntityProposerId(env, entityId, 'settle-update');
      xln.enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [{
        entityId, signerId: proposerId,
        entityTxs: [{ type: 'settle_update', data: {
          counterpartyEntityId: counterpartyId,
          ops: pendingOps,
          memo: proposeMemo || undefined,
        }}]
      }]});
      console.log('✅ Settlement updated');
      pendingOps = [];
      proposeMemo = '';
    } catch (err: any) {
      console.error('Failed to update settlement:', err);
      error.set(`Settle update failed: ${err?.message || 'Unknown error'}`);
    } finally {
      settleInFlight = false;
    }
  }

  async function settleApprove() {
    if (settleInFlight) return;
    settleInFlight = true;
    try {
      const xln = await getXLN();
      const env = activeEnv;
      if (!env) throw new Error('Environment not ready');

      const proposerId = activeXlnFunctions!.resolveEntityProposerId(env, entityId, 'settle-approve');
      xln.enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [{
        entityId, signerId: proposerId,
        entityTxs: [{ type: 'settle_approve', data: {
          counterpartyEntityId: counterpartyId,
        }}]
      }]});
      console.log('✅ Settlement approved');
    } catch (err: any) {
      console.error('Failed to approve settlement:', err);
      error.set(`Settle approve failed: ${err?.message || 'Unknown error'}`);
    } finally {
      settleInFlight = false;
    }
  }

  async function settleExecute() {
    if (settleInFlight) return;
    settleInFlight = true;
    try {
      const xln = await getXLN();
      const env = activeEnv;
      if (!env) throw new Error('Environment not ready');

      const proposerId = activeXlnFunctions!.resolveEntityProposerId(env, entityId, 'settle-execute');
      xln.enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [{
        entityId, signerId: proposerId,
        entityTxs: [{ type: 'settle_execute', data: {
          counterpartyEntityId: counterpartyId,
        }}]
      }]});
      console.log('✅ Settlement executed');
    } catch (err: any) {
      console.error('Failed to execute settlement:', err);
      error.set(`Settle execute failed: ${err?.message || 'Unknown error'}`);
    } finally {
      settleInFlight = false;
    }
  }

  async function settleReject() {
    if (settleInFlight) return;
    if (!confirm('Reject and clear the settlement workspace?')) return;
    settleInFlight = true;
    try {
      const xln = await getXLN();
      const env = activeEnv;
      if (!env) throw new Error('Environment not ready');

      const proposerId = activeXlnFunctions!.resolveEntityProposerId(env, entityId, 'settle-reject');
      xln.enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [{
        entityId, signerId: proposerId,
        entityTxs: [{ type: 'settle_reject', data: {
          counterpartyEntityId: counterpartyId,
        }}]
      }]});
      console.log('✅ Settlement rejected');
    } catch (err: any) {
      console.error('Failed to reject settlement:', err);
      error.set(`Settle reject failed: ${err?.message || 'Unknown error'}`);
    } finally {
      settleInFlight = false;
    }
  }

  // Preload existing workspace ops into pendingOps for update mode
  $: hasRawDiffOps = workspace?.ops?.some((op: any) => op.type === 'rawDiff') ?? false;

  function preloadOpsForUpdate() {
    if (!workspace) return;
    if (hasRawDiffOps) {
      if (!confirm('This proposal contains rawDiff ops that cannot be edited. Loading will drop them. Continue?')) return;
    }
    pendingOps = workspace.ops
      .filter((op: any) => op.type !== 'rawDiff')
      .map((op: any) => ({ type: op.type, tokenId: op.tokenId, amount: op.amount }));
    proposeMemo = workspace.memo || '';
  }

  async function initiateDispute() {
    if (!confirm('Are you sure you want to initiate a dispute? This will freeze the account.')) return;

    // TODO: Implement dispute initiation
    console.log('🚨 Dispute initiated');
    alert('Dispute functionality coming soon');
  }

  async function closeAccount() {
    if (!confirm('Are you sure you want to close this account? All balances must be settled first.')) return;

    // TODO: Implement cooperative close
    console.log('❌ Closing account');
    alert('Account closure functionality coming soon');
  }

</script>

<div class="account-panel">
  <div class="panel-header">
    <div class="header-row-top">
      <button class="back-button" on:click={handleBackToEntity}>
        ←
      </button>
      <div class="header-identity">
        <EntityIdentity entityId={counterpartyId} name={counterpartyName} size={28} clickable={false} compact={false} copyable={true} showAddress={true} />
      </div>
      <div class="relay-status">
        <span class="conn-dot {relayStatus}" title="{relayStatus}"></span>
        {#if relayStatus === 'reconnecting' && reconnectCountdown}
          <span class="reconnect-label">Retry in {reconnectCountdown.seconds}s (#{reconnectCountdown.attempt})</span>
        {/if}
        {#if $p2pState.queue.totalMessages > 0}
          <span class="queue-badge">{$p2pState.queue.totalMessages} queued</span>
        {/if}
      </div>
    </div>
    <div class="header-row-bottom">
      <span class="frame-badge">Frame #{account.currentFrame.height}</span>
      <span class="jheight-badge" title="Last finalized bilateral J-event height">
        J#{account.lastFinalizedJHeight ?? 0}
      </span>
      {#if account.mempool.length > 0 || account.pendingFrame}
        <span class="status-badge pending">
          {#if account.pendingFrame}
            Awaiting Consensus
          {:else}
            {account.mempool.length} pending
          {/if}
        </span>
      {:else}
        <span class="status-badge synced">Synced</span>
      {/if}
      {#if account.currentFrame.stateHash}
        <span class="trust-indicator verified" title="Cryptographically verified account state">🔒</span>
      {:else}
        <span class="trust-indicator pending" title="Awaiting cryptographic verification">⏳</span>
      {/if}
    </div>
  </div>

  <div class="panel-content">
    <!-- Always visible: Delta Cards -->
    {#each tokenDetails as td (td.tokenId)}
      {@const outTotal = td.derived.outOwnCredit + td.derived.outCollateral + td.derived.outPeerCredit}
      {@const inTotal = td.derived.inOwnCredit + td.derived.inCollateral + td.derived.inPeerCredit}
      {@const halfMax = outTotal > inTotal ? outTotal : inTotal}
      {@const pctOf = (v: bigint, base: bigint) => base > 0n ? Number((v * 10000n) / base) / 100 : 0}
      <div class="delta-card">
        <div class="delta-card-header">
          <span class="delta-token">{td.tokenInfo.symbol}</span>
          <span class="delta-net" class:positive={td.derived.delta > 0n} class:negative={td.derived.delta < 0n}>
            Net: {activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.delta)}
          </span>
          <button class="delta-faucet" on:click={() => handleFaucet(td.tokenId)}>Faucet</button>
        </div>
        <div class="delta-bar-row">
          <span class="delta-label">OUT {activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.outCapacity)}</span>
          <span class="delta-label">IN {activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.inCapacity)}</span>
        </div>
        {#if halfMax > 0n}
          <div class="delta-bar center">
            <div class="delta-half out">
              {#if td.derived.outOwnCredit > 0n}<div class="dseg credit" style="width:{pctOf(td.derived.outOwnCredit, halfMax)}%"></div>{/if}
              {#if td.derived.outCollateral > 0n}<div class="dseg coll" style="width:{pctOf(td.derived.outCollateral, halfMax)}%"></div>{/if}
              {#if td.derived.outPeerCredit > 0n}<div class="dseg debt" style="width:{pctOf(td.derived.outPeerCredit, halfMax)}%"></div>{/if}
            </div>
            <div class="delta-mid"></div>
            <div class="delta-half in">
              {#if td.derived.inOwnCredit > 0n}<div class="dseg debt" style="width:{pctOf(td.derived.inOwnCredit, halfMax)}%"></div>{/if}
              {#if td.derived.inCollateral > 0n}<div class="dseg coll" style="width:{pctOf(td.derived.inCollateral, halfMax)}%"></div>{/if}
              {#if td.derived.inPeerCredit > 0n}<div class="dseg credit" style="width:{pctOf(td.derived.inPeerCredit, halfMax)}%"></div>{/if}
            </div>
          </div>
        {/if}
        <div class="delta-details">
          <div class="detail-grid">
            <span class="detail-header"></span>
            <span class="detail-header">Limit</span>
            <span class="detail-header">OUT</span>
            <span class="detail-header">IN</span>
          </div>
          <div class="detail-grid">
            <span class="detail-label-cell">Our credit</span>
            <span class="detail-value-cell">{activeXlnFunctions?.formatTokenAmount(td.tokenId, td.ourCreditLimit)}</span>
            <span class="detail-value-cell avail">{activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.outOwnCredit)}</span>
            <span class="detail-value-cell used">{activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.inOwnCredit)}</span>
          </div>
          <div class="detail-grid">
            <span class="detail-label-cell">Their credit</span>
            <span class="detail-value-cell">{activeXlnFunctions?.formatTokenAmount(td.tokenId, td.theirCreditLimit)}</span>
            <span class="detail-value-cell used">{activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.outPeerCredit)}</span>
            <span class="detail-value-cell avail">{activeXlnFunctions?.formatTokenAmount(td.tokenId, td.derived.inPeerCredit)}</span>
          </div>
          <div class="detail-grid collateral-row">
            <span class="detail-label-cell">Collateral</span>
            <span class="detail-value-cell coll" style="grid-column: 2 / -1">{activeXlnFunctions?.formatTokenAmount(td.tokenId, td.ourCollateral)}</span>
          </div>
        </div>
      </div>
    {/each}

    <!-- Always visible: Proof Card -->
    <div class="proof-card">
      <div class="proof-header">
        <span>Frame #{account.currentFrame.height}</span>
        <span>{formatTimestamp(account.currentFrame.timestamp)}</span>
        {#if account.currentFrame.stateHash}
          <code title="{account.currentFrame.stateHash}">{account.currentFrame.stateHash.slice(0, 16)}...</code>
          <span class="proof-ok">✓</span>
        {/if}
        {#if account.hankoSignature}
          <span class="proof-ok">Signed</span>
        {:else}
          <span class="proof-pending">Pending</span>
        {/if}
      </div>
    </div>

    <!-- Tab Navigation -->
    <div class="account-tabs">
      <button class="account-tab" class:active={activeAccountTab === 'activity'} on:click={() => activeAccountTab = 'activity'}>
        Activity
        {#if pendingCount > 0}
          <span class="tab-badge">{pendingCount}</span>
        {/if}
      </button>
      <button class="account-tab" class:active={activeAccountTab === 'actions'} on:click={() => activeAccountTab = 'actions'}>
        Actions
      </button>
      <button class="account-tab" class:active={activeAccountTab === 'settle'} on:click={() => activeAccountTab = 'settle'}>
        Settle
      </button>
    </div>

    <!-- Tab: Activity -->
    {#if activeAccountTab === 'activity'}
      <!-- Pending Txs -->
      {#if account.mempool.length > 0}
        <div class="section">
          <h3>Pending Transactions</h3>
          <div class="mempool-list">
            {#each account.mempool as tx, i}
              <div class="mempool-item">
                <span class="tx-index">#{i + 1}</span>
                <span class="tx-type">{tx.type}</span>
                {#if 'amount' in tx.data && tx.data.amount}
                  <span class="tx-amount">{safeFixed((Number(tx.data.amount) / 1e18), 4)}</span>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Frame History -->
      <div class="section">
        <h3>Account Frame History ({account.frameHistory?.length || 0} confirmed frames)</h3>
        <div class="frame-history">
          {#if account.pendingFrame}
            <div class="frame-item pending">
              <div class="frame-header">
                <span class="frame-id">Pending Frame #{account.pendingFrame.height}</span>
                <span class="frame-status pending">Awaiting Consensus</span>
                <span class="frame-timestamp">{formatTimestamp(account.pendingFrame.timestamp)}</span>
              </div>
              <div class="frame-details">
                <div class="frame-detail">
                  <span class="detail-label">Transactions:</span>
                  <span class="detail-value">{account.pendingFrame.accountTxs.length}</span>
                </div>
                <div class="frame-detail">
                  <span class="detail-label">Signatures:</span>
                  <span class="detail-value">{account.pendingSignatures?.length || 0}/2</span>
                </div>
                <div class="pending-transactions">
                  {#each account.pendingFrame.accountTxs as tx, i}
                    <div class="pending-tx">
                      <span class="tx-index">{i+1}.</span>
                      <span class="tx-type">{tx.type}</span>
                      {#if tx.type === 'direct_payment'}
                        <span class="tx-amount">{activeXlnFunctions?.formatTokenAmount(tx.data.tokenId, tx.data.amount)}</span>
                        <span class="tx-desc">{tx.data.description || ''}</span>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
            </div>
          {/if}

          {#if account.mempool.length > 0}
            <div class="frame-item mempool">
              <div class="frame-header">
                <span class="frame-id">Mempool Queue</span>
                <span class="frame-status mempool">{account.mempool.length} Queued</span>
              </div>
              <div class="frame-details">
                <div class="mempool-transactions">
                  {#each account.mempool as tx, i}
                    <div class="mempool-tx">
                      <span class="tx-index">{i+1}.</span>
                      <span class="tx-type">{tx.type}</span>
                      {#if tx.type === 'direct_payment'}
                        <span class="tx-amount">{activeXlnFunctions?.formatTokenAmount(tx.data.tokenId, tx.data.amount)}</span>
                        <span class="tx-desc">"{tx.data.description || 'no description'}"</span>
                        <span class="tx-token">Token #{tx.data.tokenId}</span>
                      {:else if tx.type === 'set_credit_limit'}
                        <span class="tx-amount">{activeXlnFunctions?.formatTokenAmount(tx.data.tokenId, tx.data.amount)}</span>
                        <span class="tx-desc">Credit extension</span>
                      {:else}
                        <span class="tx-desc">{activeXlnFunctions?.safeStringify(tx.data)}</span>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
            </div>
          {/if}

          {#if account.currentFrame}
            <div class="frame-item current">
              <div class="frame-header">
                <span class="frame-id">Current Frame #{account.currentFrame.height || account.currentHeight}</span>
                <span class="frame-status current">Active</span>
                <span class="frame-timestamp">{formatTimestamp(account.currentFrame.timestamp || Date.now())}</span>
              </div>
              <div class="frame-details">
                <div class="frame-detail">
                  <span class="detail-label">Transactions:</span>
                  <span class="detail-value">{account.currentFrame?.accountTxs?.length || 0}</span>
                </div>
                <div class="frame-detail">
                  <span class="detail-label">State Hash:</span>
                  <span class="detail-value hash">
                    {#if account.currentFrame}
                      frame#{account.currentFrame.height}_{account.currentFrame.timestamp.toString().slice(-6)}
                    {:else}
                      <span style="color: #ff4444; font-weight: bold;">NO FRAME</span>
                    {/if}
                  </span>
                </div>
              </div>
            </div>
          {/if}

          {#if account.frameHistory && account.frameHistory.length > 0}
            <div class="historical-frames">
              <h4>Historical Frames (last {Math.min(10, account.frameHistory.length)}):</h4>
              {#each account.frameHistory.slice(-10).reverse() as frame}
                <div class="frame-item historical">
                  <div class="frame-header">
                    <span class="frame-id">Frame #{frame.height}</span>
                    <span class="frame-status historical">Confirmed</span>
                    <span class="frame-timestamp">{formatTimestamp(frame.timestamp)}</span>
                  </div>
                  <div class="frame-details">
                    <div class="frame-detail">
                      <span class="detail-label">Transactions:</span>
                      <span class="detail-value">{frame.accountTxs.length}</span>
                    </div>
                    <div class="frame-detail">
                      <span class="detail-label">Proposer:</span>
                      <span class="detail-value">{frame.byLeft === true ? (iAmLeft ? 'Left (you)' : 'Left') : frame.byLeft === false ? (iAmLeft ? 'Right' : 'Right (you)') : '—'}</span>
                    </div>
                    <div class="frame-detail">
                      <span class="detail-label">Tokens:</span>
                      <span class="detail-value">{frame.tokenIds?.join(', ') || 'None'}</span>
                    </div>
                    <div class="frame-detail">
                      <span class="detail-label">Hash:</span>
                      <span class="detail-value hash">
                        {#if frame.stateHash}
                          {frame.stateHash.slice(0,8)}...
                        {:else}
                          <span style="color: #ff4444; font-weight: bold;">MISSING HASH</span>
                        {/if}
                      </span>
                    </div>
                  </div>
                  {#if frame.accountTxs && frame.accountTxs.length > 0}
                    <div class="frame-txs-list">
                      {#each frame.accountTxs as tx, idx}
                        <div class="frame-tx-item">
                          <span class="tx-index">{idx + 1}.</span>
                          <span class="tx-type">{tx.type}</span>
                          <span class="tx-data">{JSON.stringify(tx.data, (_k, v) => typeof v === 'bigint' ? v.toString() : v)}</span>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          {#if !account.currentFrame && !account.pendingFrame && account.mempool.length === 0 && (!account.frameHistory || account.frameHistory.length === 0)}
            <div class="no-frames">
              No account activity yet. Send a payment to start bilateral consensus.
            </div>
          {/if}
        </div>
      </div>

    <!-- Tab: Actions -->
    {:else if activeAccountTab === 'actions'}
      <div class="section">
        <PaymentForm {entityId} signerId={formSignerId} counterpartyId={counterpartyId} />
        {#if replica && tab}
          <SwapPanel {replica} {tab} counterpartyId={counterpartyId} prefilledCounterparty={true} />
        {/if}
        <CreditForm {entityId} signerId={formSignerId} counterpartyId={counterpartyId} />
      </div>

    <!-- Tab: Settle -->
    {:else if activeAccountTab === 'settle'}
      <div class="section">
        <CollateralForm {entityId} signerId={formSignerId} counterpartyId={counterpartyId} />
      </div>

      <!-- Settlement Workspace (kept inline) -->
      <div class="action-card settle-workspace">
        <h4>Settlement</h4>

        {#if workspace}
          <!-- Active workspace -->
          <div class="ws-status-row">
            <span class="ws-status-badge {wsStatus}">{wsStatus?.replace(/_/g, ' ')}</span>
            <span class="ws-version">v{workspace.version}</span>
            <span class="ws-executor">{workspace.executorIsLeft === iAmLeft ? 'You execute' : 'They execute'}</span>
          </div>

          {#if workspace.memo}
            <div class="ws-memo">{workspace.memo}</div>
          {/if}

          <!-- Ops list (read-only) -->
          <div class="ws-ops">
            {#each wsOps as op, i}
              <div class="settle-op {op.type}">
                <span class="op-type">{op.type}</span>
                {#if op.type === 'rawDiff'}
                  <span class="raw-diff-warning">RAW</span>
                  <span class="op-raw-details">
                    L:{activeXlnFunctions?.formatTokenAmount(op.tokenId, op.leftDiff)}
                    R:{activeXlnFunctions?.formatTokenAmount(op.tokenId, op.rightDiff)}
                    C:{activeXlnFunctions?.formatTokenAmount(op.tokenId, op.collateralDiff)}
                    O:{activeXlnFunctions?.formatTokenAmount(op.tokenId, op.ondeltaDiff)}
                  </span>
                {:else if op.type !== 'forgive' && 'amount' in op}
                  <span class="op-amount">{activeXlnFunctions?.formatTokenAmount(op.tokenId, op.amount)}</span>
                {/if}
                <span class="op-token">Token #{op.tokenId}</span>
              </div>
            {/each}
          </div>

          {#if workspace.compiledDiffs && workspace.compiledDiffs.length > 0}
            <div class="ws-diffs-preview">
              <span class="ws-diffs-label">Compiled diffs:</span>
              {#each workspace.compiledDiffs as diff}
                <div class="ws-diff-row">
                  Token #{diff.tokenId}: L{diff.leftDiff >= 0n ? '+' : ''}{activeXlnFunctions?.formatTokenAmount(diff.tokenId, diff.leftDiff)}
                  R{diff.rightDiff >= 0n ? '+' : ''}{activeXlnFunctions?.formatTokenAmount(diff.tokenId, diff.rightDiff)}
                  C{diff.collateralDiff >= 0n ? '+' : ''}{activeXlnFunctions?.formatTokenAmount(diff.tokenId, diff.collateralDiff)}
                </div>
              {/each}
            </div>
          {/if}

          <!-- Hanko status -->
          <div class="hanko-status-row">
            <div class="hanko-item" class:signed={myHanko}>
              <span class="hanko-label">You:</span>
              <span class="hanko-value">{myHanko ? 'Signed' : 'Pending'}</span>
            </div>
            <div class="hanko-item" class:signed={theirHanko}>
              <span class="hanko-label">Counterparty:</span>
              <span class="hanko-value">{theirHanko ? 'Signed' : 'Pending'}</span>
            </div>
          </div>

          <!-- Update form (proposer can revise before any hankos) -->
          {#if canUpdate}
            <div class="settle-update-section">
              <div class="update-header">
                <span class="update-label">Replace Proposal</span>
                {#if pendingOps.length === 0}
                  <button class="action-button secondary" on:click={preloadOpsForUpdate}>Load Current Ops</button>
                {/if}
              </div>
              <div class="settle-form">
                <div class="settle-form-row">
                  <select bind:value={settleTokenId} class="form-select">
                    {#each tokenDetails as td}
                      <option value={td.tokenId}>{td.tokenInfo.symbol}</option>
                    {/each}
                  </select>
                  <select bind:value={settleOpType} class="form-select">
                    <option value="r2c">r2c (deposit)</option>
                    <option value="c2r">c2r (withdraw)</option>
                    <option value="r2r">r2r (transfer)</option>
                    <option value="forgive">forgive</option>
                  </select>
                  {#if settleOpType !== 'forgive'}
                    <BigIntInput bind:value={settleAmountBigInt} decimals={18} placeholder="Amount" />
                  {/if}
                  <button class="action-button secondary" on:click={addSettleOp}>Add</button>
                </div>
                {#if pendingOps.length > 0}
                  <div class="pending-ops">
                    {#each pendingOps as op, i}
                      <div class="settle-op {op.type}">
                        <span class="op-type">{op.type}</span>
                        {#if op.amount}
                          <span class="op-amount">{activeXlnFunctions?.formatTokenAmount(op.tokenId, op.amount)}</span>
                        {/if}
                        <span class="op-token">Token #{op.tokenId}</span>
                        <button class="op-remove" on:click={() => removeSettleOp(i)}>x</button>
                      </div>
                    {/each}
                  </div>
                  <input type="text" placeholder="Memo (optional)" bind:value={proposeMemo} class="form-input" />
                  <button class="action-button propose" on:click={settleUpdate} disabled={settleInFlight}>
                    {settleInFlight ? 'Submitting...' : 'Replace Proposal'}
                  </button>
                {/if}
              </div>
            </div>
          {/if}

          <!-- Action buttons -->
          <div class="settle-actions">
            {#if canApprove}
              <button class="action-button approve" on:click={settleApprove} disabled={settleInFlight}>
                {settleInFlight ? 'Submitting...' : 'Approve'}
              </button>
            {/if}
            {#if canExecute}
              <button class="action-button execute" on:click={settleExecute} disabled={settleInFlight}>
                {settleInFlight ? 'Submitting...' : 'Execute'}
              </button>
            {/if}
            <button class="action-button reject" on:click={settleReject} disabled={settleInFlight}>
              {settleInFlight ? 'Submitting...' : 'Reject'}
            </button>
          </div>

        {:else}
          <!-- No workspace — Propose form -->
          <div class="settle-form">
            <div class="settle-form-row">
              <select bind:value={settleTokenId} class="form-select">
                {#each tokenDetails as td}
                  <option value={td.tokenId}>{td.tokenInfo.symbol}</option>
                {/each}
              </select>
              <select bind:value={settleOpType} class="form-select">
                <option value="r2c">r2c (deposit)</option>
                <option value="c2r">c2r (withdraw)</option>
                <option value="r2r">r2r (transfer)</option>
                <option value="forgive">forgive</option>
              </select>
              {#if settleOpType !== 'forgive'}
                <BigIntInput bind:value={settleAmountBigInt} decimals={18} placeholder="Amount" />
              {/if}
              <button class="action-button secondary" on:click={addSettleOp}>Add</button>
            </div>

            {#if pendingOps.length > 0}
              <div class="pending-ops">
                {#each pendingOps as op, i}
                  <div class="settle-op {op.type}">
                    <span class="op-type">{op.type}</span>
                    {#if op.amount}
                      <span class="op-amount">{activeXlnFunctions?.formatTokenAmount(op.tokenId, op.amount)}</span>
                    {/if}
                    <span class="op-token">Token #{op.tokenId}</span>
                    <button class="op-remove" on:click={() => removeSettleOp(i)}>x</button>
                  </div>
                {/each}
              </div>

              <!-- Settlement preview ghost bar -->
              {#if settlePreview.length > 0}
                <div class="settle-preview">
                  <span class="preview-label">After settlement:</span>
                  {#each settlePreview as sp}
                    <div class="preview-token">
                      <span class="preview-token-label" style="color: {sp.tokenInfo.color}">{sp.tokenInfo.symbol}</span>
                      <div class="preview-bars">
                        <div class="preview-bar current">
                          {#if sp.current.outCapacity > 0n || sp.current.inCapacity > 0n}
                            <div class="preview-segment out" style="width: {sp.current.totalCapacity > 0n ? Number((sp.current.outCapacity * 100n) / sp.current.totalCapacity) : 50}%"></div>
                            <div class="preview-sep"></div>
                            <div class="preview-segment in" style="width: {sp.current.totalCapacity > 0n ? Number((sp.current.inCapacity * 100n) / sp.current.totalCapacity) : 50}%"></div>
                          {/if}
                        </div>
                        <div class="preview-bar ghost">
                          {#if sp.preview.outCapacity > 0n || sp.preview.inCapacity > 0n}
                            <div class="preview-segment out" style="width: {sp.preview.totalCapacity > 0n ? Number((sp.preview.outCapacity * 100n) / sp.preview.totalCapacity) : 50}%"></div>
                            <div class="preview-sep"></div>
                            <div class="preview-segment in" style="width: {sp.preview.totalCapacity > 0n ? Number((sp.preview.inCapacity * 100n) / sp.preview.totalCapacity) : 50}%"></div>
                          {/if}
                        </div>
                      </div>
                      <div class="preview-diff">
                        <span>Collateral {sp.collateralDiff >= 0n ? '+' : ''}{activeXlnFunctions?.formatTokenAmount(sp.tokenId, sp.collateralDiff)}</span>
                        <span>OUT {activeXlnFunctions?.formatTokenAmount(sp.tokenId, sp.current.outCapacity)} → {activeXlnFunctions?.formatTokenAmount(sp.tokenId, sp.preview.outCapacity)}</span>
                        <span>IN {activeXlnFunctions?.formatTokenAmount(sp.tokenId, sp.current.inCapacity)} → {activeXlnFunctions?.formatTokenAmount(sp.tokenId, sp.preview.inCapacity)}</span>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            {/if}

            <input
              type="text"
              placeholder="Memo (optional)"
              bind:value={proposeMemo}
              class="form-input"
            />
            <button
              class="action-button propose"
              on:click={settlePropose}
              disabled={pendingOps.length === 0 || settleInFlight}
            >
              {settleInFlight ? 'Submitting...' : 'Propose Settlement'}
            </button>
          </div>
        {/if}
      </div>

      <!-- Dispute / Close buttons -->
      <div class="action-card management-card">
        <h4>Account Management</h4>
        <div class="management-buttons">
          <button class="action-button dispute" on:click={initiateDispute}>
            Initiate Dispute
          </button>
          <button class="action-button close" on:click={closeAccount}>
            Close Account
          </button>
        </div>
      </div>
    {/if}
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
    gap: 0;
    padding: 0;
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
    padding-left: 52px; /* align with identity (back button width + gap) */
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
    transition: all 0.15s ease;
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
    flex-shrink: 0;
  }

  .conn-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .conn-dot.connected {
    background: #4ade80;
    box-shadow: 0 0 4px rgba(74, 222, 128, 0.5);
  }

  .conn-dot.reconnecting {
    background: #fbbf24;
    animation: conn-pulse 2s infinite;
  }

  .conn-dot.disconnected {
    background: #57534e;
  }

  @keyframes conn-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .reconnect-label {
    font-size: 0.65em;
    color: #fbbf24;
    font-family: monospace;
  }

  .queue-badge {
    font-size: 0.65em;
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.1);
    padding: 2px 6px;
    border-radius: 3px;
    font-family: monospace;
  }

  .frame-badge {
    padding: 3px 10px;
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 6px;
    font-size: 0.75em;
    color: #a1a1aa;
    font-family: 'JetBrains Mono', monospace;
    letter-spacing: 0.02em;
  }

  .jheight-badge {
    padding: 3px 10px;
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.25);
    border-radius: 6px;
    font-size: 0.75em;
    color: #93c5fd;
    font-family: 'JetBrains Mono', monospace;
    letter-spacing: 0.02em;
  }

  .status-badge {
    font-size: 0.72em;
    padding: 3px 10px;
    border-radius: 6px;
    font-weight: 500;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .status-badge.synced {
    color: #4ade80;
    background: rgba(74, 222, 128, 0.1);
    border: 1px solid rgba(74, 222, 128, 0.15);
  }

  .status-badge.pending {
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.15);
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
    gap: 8px;
  }

  .section {
    margin-bottom: 8px;
  }

  .section h3 {
    margin: 12px 0 10px 0;
    color: #a1a1aa;
    font-size: 0.8em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .token-detail-card {
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 12px;
  }

  .token-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .token-name {
    font-weight: 600;
    font-size: 1.1em;
  }

  .net-position {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.95em;
    padding: 4px 8px;
    border-radius: 4px;
    background: #0c0a09;
  }

  .net-position.positive {
    color: #4ec9b0;
  }

  .net-position.negative {
    color: #f48771;
  }





  .bar-segment {
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    min-width: 0;
  }


  /* Pink - Unused credit */

  /* Green - Collateral */
  .bar-segment.collateral {
    background: linear-gradient(135deg, #4ec9b0, #5fd4bc);
  }

  /* Orange - Used credit */

  /* Unified capacity bar styles */
  .unified-capacity-bar {
    margin-bottom: 16px;
  }

  .bar-segments {
    display: flex;
    height: 40px;
    border-radius: 6px;
    overflow: hidden;
    background: #1a1a1a;
    border: 1px solid #333;
    margin-bottom: 8px;
  }

  .bar-legend {
    display: flex;
    gap: 12px;
    font-size: 0.7em;
    color: #888;
    flex-wrap: wrap;
    justify-content: center;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .legend-color {
    width: 12px;
    height: 12px;
    border-radius: 2px;
    border: 1px solid #444;
  }

  .their-unused-bg {
    background: linear-gradient(135deg, rgba(255, 107, 157, 0.5), rgba(198, 66, 116, 0.7));
  }

  .their-used-bg {
    background: linear-gradient(135deg, #ff6b9d, #c64274);
  }

  .collateral-bg {
    background: linear-gradient(135deg, #4facfe, #00c8ff);
  }

  .their-collateral-bg {
    background: linear-gradient(135deg, #4facfe, #00c8ff);
  }

  .bar-segment.their-collateral {
    background: linear-gradient(135deg, #4facfe, #00c8ff);
  }

  .our-used-bg {
    background: linear-gradient(135deg, #ff9a56, #cc6d2e);
  }

  .our-unused-bg {
    background: linear-gradient(135deg, rgba(255, 154, 86, 0.5), rgba(204, 109, 46, 0.7));
  }

  .capacity-summary {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    padding: 12px;
    background: #0c0a09;
    border-radius: 4px;
    margin-bottom: 12px;
  }

  .capacity-item {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  /* ── Delta cards (per-token, AccountPreview-style) ── */
  .delta-card {
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 10px;
    padding: 14px 16px;
    margin-bottom: 8px;
    transition: border-color 0.15s;
  }
  .delta-card:hover {
    border-color: #3f3f46;
  }
  .delta-card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .delta-token {
    font-weight: 700;
    color: #e4e4e7;
    font-size: 0.95em;
    letter-spacing: 0.02em;
  }
  .delta-net {
    flex: 1;
    text-align: right;
    font-family: 'JetBrains Mono','SF Mono','Monaco','Menlo',monospace;
    font-size: 0.85em;
    color: #71717a;
    font-weight: 500;
  }
  .delta-net.positive { color: #4ade80; }
  .delta-net.negative { color: #f43f5e; }
  .delta-faucet {
    font-size: 0.65em;
    padding: 3px 10px;
    border-radius: 5px;
    border: 1px solid #3f3f46;
    background: transparent;
    color: #71717a;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 500;
    transition: all 0.15s;
  }
  .delta-faucet:hover { border-color: #0ea5e9; color: #0ea5e9; background: rgba(14, 165, 233, 0.05); }

  .delta-bar-row {
    display: flex;
    justify-content: space-between;
    font-family: 'JetBrains Mono','SF Mono','Monaco','Menlo',monospace;
    font-size: 0.68em;
    color: #52525b;
    margin-bottom: 4px;
  }
  .delta-label { color: #71717a; font-weight: 500; }

  .delta-bar {
    display: flex;
    align-items: stretch;
    height: 10px;
    background: #27272a;
    border-radius: 5px;
    overflow: hidden;
    margin-bottom: 12px;
  }
  .delta-bar.center { flex-direction: row; }
  .delta-half { flex:1; display:flex; align-items:stretch; overflow:hidden; }
  .delta-half.out { justify-content: flex-end; }
  .delta-half.in { justify-content: flex-start; }
  .delta-mid { width:2px; background:#52525b; flex-shrink:0; border-radius: 1px; }
  .dseg { min-width: 2px; transition: width 0.3s ease; }
  .dseg.credit { background: #52525b; }
  .dseg.coll { background: linear-gradient(180deg, #34d399, #10b981); }
  .dseg.debt { background: linear-gradient(180deg, #fb7185, #f43f5e); }

  .delta-details {
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .detail-grid {
    display: grid;
    grid-template-columns: 90px 1fr 1fr 1fr;
    gap: 0 8px;
    padding: 4px 0;
    border-bottom: 1px solid #1f1f23;
    font-family: 'JetBrains Mono','SF Mono','Monaco','Menlo',monospace;
    font-size: 0.72em;
  }
  .detail-grid:last-child { border-bottom: none; }
  .detail-grid.collateral-row { border-bottom: none; }
  .detail-header {
    color: #52525b;
    font-size: 0.9em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
  }
  .detail-label-cell {
    color: #a1a1aa;
    font-weight: 500;
  }
  .detail-value-cell {
    color: #71717a;
    text-align: right;
  }
  .detail-value-cell.used { color: #f97316; }
  .detail-value-cell.avail { color: #4ade80; }
  .detail-value-cell.coll { color: #2dd4bf; }

  /* ── Account Tabs ── */
  .account-tabs {
    display: flex;
    gap: 2px;
    margin: 12px 0 8px;
    border-bottom: 1px solid #27272a;
  }

  .account-tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 16px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: #71717a;
    font-size: 0.82em;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    letter-spacing: 0.02em;
  }

  .account-tab:hover {
    color: #a1a1aa;
    background: rgba(255, 255, 255, 0.02);
  }

  .account-tab.active {
    color: #fbbf24;
    border-bottom-color: #fbbf24;
    background: rgba(251, 191, 36, 0.04);
  }

  .tab-badge {
    background: #f59e0b;
    color: #000;
    font-size: 0.75em;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 10px;
    min-width: 18px;
    text-align: center;
  }

  .proof-card {
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 10px;
    padding: 10px 14px;
    margin-top: 8px;
  }
  .proof-header {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 0.72em;
    font-family: 'JetBrains Mono','SF Mono','Monaco','Menlo',monospace;
    color: #52525b;
  }
  .proof-header code { color: #71717a; }
  .proof-ok { color: #4ade80; }
  .proof-pending { color: #fbbf24; }

  .capacity-label {
    font-size: 0.75em;
    color: #888;
    margin-bottom: 4px;
  }

  .capacity-value {
    font-family: monospace;
    font-weight: 600;
  }

  .capacity-value.outbound {
    color: #ce9178;
  }

  .capacity-value.inbound {
    color: #4ec9b0;
  }

  .credit-details {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.85em;
  }

  .credit-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 8px;
    background: #0c0a09;
    border-radius: 3px;
  }

  .credit-row span:first-child {
    color: #888;
  }

  .credit-row span:last-child {
    font-family: monospace;
    color: #d4d4d4;
  }

  .action-card {
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 10px;
    padding: 16px 18px;
    margin-bottom: 10px;
    transition: border-color 0.15s;
  }

  .action-card:hover {
    border-color: #3f3f46;
  }

  .action-card h4 {
    margin: 0 0 14px 0;
    color: #e4e4e7;
    font-size: 0.88em;
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  .action-form {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .action-form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .form-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .form-row.wide {
    grid-column: 1 / -1;
  }

  .form-row.action-row {
    grid-column: 1 / -1;
    justify-self: end;
  }

  .form-label {
    font-size: 0.68em;
    color: #71717a;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
  }

  .form-select,
  .form-input {
    padding: 9px 10px;
    background: #09090b;
    border: 1px solid #27272a;
    border-radius: 8px;
    color: #e4e4e7;
    font-size: 0.88em;
    transition: border-color 0.15s;
  }

  .form-select {
    min-width: 100px;
  }

  .form-input {
    flex: 1;
  }

  .form-input:focus,
  .form-select:focus {
    border-color: #fbbf24;
    outline: none;
    box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.1);
  }

  .action-button {
    padding: 9px 18px;
    border: none;
    border-radius: 8px;
    font-weight: 600;
    font-size: 0.82em;
    cursor: pointer;
    transition: all 0.15s ease;
    letter-spacing: 0.02em;
  }

  .action-button.primary {
    background: linear-gradient(135deg, #2563eb, #1d4ed8);
    color: white;
    box-shadow: 0 1px 3px rgba(37, 99, 235, 0.3);
  }

  .action-button.primary:hover {
    background: linear-gradient(135deg, #3b82f6, #2563eb);
    box-shadow: 0 2px 6px rgba(37, 99, 235, 0.4);
  }

  .action-button.secondary {
    background: linear-gradient(135deg, #1e40af, #1e3a8a);
    color: white;
    box-shadow: 0 1px 3px rgba(30, 64, 175, 0.3);
  }

  .action-button.secondary:hover {
    background: linear-gradient(135deg, #2563eb, #1e40af);
    box-shadow: 0 2px 6px rgba(30, 64, 175, 0.4);
  }

  .management-card {
    background: #1a1a1e;
    border-color: #2a2a30;
    margin-top: 8px;
  }

  .management-buttons {
    display: flex;
    gap: 10px;
  }

  .action-button.settle {
    background: linear-gradient(135deg, #0d9488, #0f766e);
    color: white;
  }

  .action-button.settle:hover {
    background: linear-gradient(135deg, #14b8a6, #0d9488);
  }

  .action-button.dispute {
    background: transparent;
    border: 1px solid #f43f5e;
    color: #f43f5e;
  }

  .action-button.dispute:hover {
    background: rgba(244, 63, 94, 0.1);
  }

  .action-button.close {
    background: transparent;
    border: 1px solid #52525b;
    color: #a1a1aa;
  }

  .action-button.close:hover {
    background: rgba(82, 82, 91, 0.2);
    border-color: #71717a;
  }

  .mempool-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .mempool-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 4px;
    font-size: 0.85em;
  }

  .tx-index {
    color: #888;
    font-weight: 600;
  }

  .tx-type {
    color: #9cdcfe;
    font-family: monospace;
  }

  .tx-amount {
    margin-left: auto;
    color: #ce9178;
    font-family: monospace;
  }

  /* Historical frame transaction list styling */
  .frame-txs-list {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid #292524;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .frame-tx-item {
    display: flex;
    gap: 8px;
    padding: 6px;
    background: #0c0a09;
    border-radius: 3px;
    font-size: 0.75em;
    align-items: flex-start;
  }

  .frame-tx-item .tx-index {
    color: #666;
    min-width: 20px;
  }

  .frame-tx-item .tx-type {
    color: #4ec9b0;
    font-family: monospace;
    font-weight: 600;
    min-width: 120px;
  }

  .frame-tx-item .tx-data {
    color: #888;
    font-family: monospace;
    font-size: 0.9em;
    word-break: break-all;
    flex: 1;
  }

  /* Account Frame History Styles */
  .frame-history {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .frame-item {
    background: #18181b;
    border-radius: 10px;
    border: 1px solid #27272a;
    overflow: hidden;
    transition: border-color 0.15s;
  }

  .frame-item.current {
    border-color: rgba(16, 185, 129, 0.4);
  }

  .frame-item.pending {
    border-color: rgba(245, 158, 11, 0.4);
  }

  .frame-item.mempool {
    border-color: rgba(99, 102, 241, 0.4);
  }

  .frame-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    background: #18181b;
    border-bottom: 1px solid #1f1f23;
  }

  .frame-id {
    font-weight: 600;
    color: #d4d4d4;
    font-family: monospace;
  }

  .frame-status {
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 0.75em;
    font-weight: 600;
  }

  .frame-status.current {
    background: rgba(16, 185, 129, 0.2);
    color: #10b981;
  }

  .frame-status.pending {
    background: rgba(245, 158, 11, 0.2);
    color: #f59e0b;
  }

  .frame-status.mempool {
    background: rgba(99, 102, 241, 0.2);
    color: #6366f1;
  }

  .frame-status.historical {
    background: rgba(156, 163, 175, 0.2);
    color: #9ca3af;
  }

  .frame-timestamp {
    font-size: 0.8em;
    color: #9d9d9d;
    font-family: monospace;
  }

  .resend-button {
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid #f59e0b;
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
    font-size: 0.75em;
    font-weight: 600;
    cursor: pointer;
  }

  .resend-button:hover {
    background: rgba(245, 158, 11, 0.25);
  }

  .frame-details {
    padding: 8px 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .frame-detail {
    display: flex;
    gap: 4px;
    align-items: center;
  }

  .detail-label {
    color: #9d9d9d;
    font-size: 0.8em;
  }

  .detail-value {
    color: #d4d4d4;
    font-family: monospace;
    font-size: 0.8em;
  }

  .detail-value.hash {
    color: #9cdcfe;
  }

  .mempool-transactions {
    width: 100%;
    margin-top: 8px;
    padding: 8px;
    background: #0c0a09;
    border-radius: 4px;
  }

  .mempool-tx, .pending-tx {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 0.8em;
    color: #d6d3d1;
    font-family: 'JetBrains Mono', monospace;
    margin-bottom: 4px;
    padding: 4px;
    background: #1c1917;
    border-radius: 2px;
  }

  .pending-transactions {
    width: 100%;
    margin-top: 8px;
    padding: 8px;
    background: #0c0a09;
    border-radius: 4px;
  }

  .tx-desc {
    color: #9d9d9d;
    font-style: italic;
  }

  .tx-token {
    color: #6366f1;
    font-size: 0.75em;
  }

  .no-frames {
    text-align: center;
    color: #6c757d;
    font-style: italic;
    font-size: 0.9em;
    padding: 20px;
  }

  /* Canonical State Styles */
  .canonical-data {
    background: #0c0a09;
    border: 1px solid #292524;
    border-radius: 6px;
    padding: 12px;
  }

  .canonical-note {
    font-size: 0.85em;
    color: #9d9d9d;
    margin-bottom: 12px;
    font-style: italic;
  }

  .canonical-token {
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid #292524;
  }

  .canonical-token:last-child {
    border-bottom: none;
    margin-bottom: 0;
  }

  .token-id-label {
    font-weight: bold;
    color: #d4d4d4;
    margin-bottom: 8px;
  }

  .canonical-values {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 8px;
    margin-bottom: 12px;
  }

  .canonical-item {
    display: flex;
    justify-content: space-between;
    font-size: 0.85em;
    font-family: monospace;
  }

  .canonical-key {
    color: #9cdcfe;
    font-weight: 500;
  }

  .canonical-value {
    color: #ce9178;
    font-weight: 600;
  }

  /* Hanko Signature Proof Styles */
  .signature-proof-section {
    margin-top: 16px;
    padding: 12px;
    background: #0c0a09;
    border: 1px solid #292524;
    border-radius: 6px;
    border-left: 3px solid #fbbf24;
  }

  .signature-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 0.9em;
    font-weight: 600;
  }

  .proof-icon {
    font-size: 1.1em;
  }

  .proof-title {
    color: #fbbf24;
  }

  .frame-info {
    margin-left: auto;
    color: #888;
    font-size: 0.85em;
    font-family: monospace;
  }

  .signature-details {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .signature-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.8em;
  }

  .sig-label {
    min-width: 80px;
    color: #ccc;
    font-size: 0.85em;
  }

  .sig-value {
    font-family: 'JetBrains Mono', monospace;
    background: #1c1917;
    padding: 2px 6px;
    border-radius: 3px;
    color: #d6d3d1;
    border: 1px solid #292524;
    cursor: pointer;
    transition: background 0.2s;
  }

  .sig-value:hover {
    background: #292524;
  }

  .sig-value.pending {
    background: transparent;
    border: none;
    color: #888;
    font-style: italic;
  }

  .sig-status {
    margin-left: auto;
    font-size: 0.9em;
  }

  .sig-status.verified {
    color: #00ff88;
  }

  .timestamp-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.75em;
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid #292524;
  }

  .timestamp-label {
    color: #999;
  }

  .timestamp-value {
    font-family: monospace;
    color: #dcdcaa;
  }

  /* Settlement Workspace Styles */
  .settle-workspace {
    border-left: 3px solid #0d9488;
  }

  .ws-status-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }

  .ws-status-badge {
    padding: 3px 8px;
    border-radius: 3px;
    font-size: 0.75em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .ws-status-badge.draft { color: #a8a29e; background: rgba(168, 162, 158, 0.15); }
  .ws-status-badge.awaiting_counterparty { color: #fbbf24; background: rgba(251, 191, 36, 0.15); }
  .ws-status-badge.ready_to_submit { color: #4ade80; background: rgba(74, 222, 128, 0.15); }
  .ws-status-badge.submitted { color: #60a5fa; background: rgba(96, 165, 250, 0.15); }

  .ws-version {
    font-size: 0.7em;
    color: #666;
    font-family: monospace;
  }

  .ws-executor {
    font-size: 0.7em;
    color: #888;
    margin-left: auto;
  }

  .ws-memo {
    font-size: 0.8em;
    color: #a8a29e;
    font-style: italic;
    padding: 6px 8px;
    background: #0c0a09;
    border-radius: 3px;
    margin-bottom: 10px;
  }

  .ws-ops {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
  }

  .settle-op {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 3px;
    font-size: 0.8em;
    font-family: monospace;
    background: #0c0a09;
    border-left: 3px solid #666;
  }

  .settle-op.r2c { border-left-color: #10b981; }
  .settle-op.c2r { border-left-color: #f59e0b; }
  .settle-op.r2r { border-left-color: #3b82f6; }
  .settle-op.forgive { border-left-color: #6b7280; }

  .op-type {
    font-weight: 600;
    color: #d6d3d1;
    min-width: 50px;
  }

  .op-amount {
    color: #ce9178;
  }

  .op-token {
    color: #888;
    font-size: 0.85em;
    margin-left: auto;
  }

  .op-remove {
    background: none;
    border: none;
    color: #ef4444;
    cursor: pointer;
    font-size: 0.9em;
    padding: 0 4px;
  }

  .op-remove:hover {
    color: #f87171;
  }

  .ws-diffs-preview {
    padding: 8px;
    background: #0c0a09;
    border-radius: 3px;
    margin-bottom: 10px;
    font-size: 0.75em;
    font-family: monospace;
  }

  .ws-diffs-label {
    color: #888;
    display: block;
    margin-bottom: 4px;
  }

  .ws-diff-row {
    color: #9cdcfe;
    padding: 2px 0;
  }

  .hanko-status-row {
    display: flex;
    gap: 16px;
    margin-bottom: 10px;
    padding: 8px;
    background: #0c0a09;
    border-radius: 3px;
  }

  .hanko-item {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 0.8em;
  }

  .hanko-label {
    color: #888;
  }

  .hanko-value {
    color: #a8a29e;
  }

  .hanko-item.signed .hanko-value {
    color: #4ade80;
  }

  .settle-actions {
    display: flex;
    gap: 8px;
  }

  .action-button.approve {
    background: #10b981;
    color: white;
  }

  .action-button.approve:hover {
    background: #059669;
  }

  .action-button.execute {
    background: #3b82f6;
    color: white;
  }

  .action-button.execute:hover {
    background: #2563eb;
  }

  .action-button.reject {
    background: #6b7280;
    color: white;
  }

  .action-button.reject:hover {
    background: #4b5563;
  }

  .action-button.propose {
    background: #0d7377;
    color: white;
    width: 100%;
    margin-top: 8px;
  }

  .action-button.propose:hover {
    background: #0a5d61;
  }

  .action-button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .settle-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .settle-form-row {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }

  .pending-ops {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px;
    background: #0c0a09;
    border-radius: 4px;
  }

  /* rawDiff warning */
  .raw-diff-warning {
    background: #dc2626;
    color: white;
    font-size: 0.65em;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 2px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .op-raw-details {
    font-size: 0.75em;
    color: #f87171;
    font-family: monospace;
  }

  .settle-op.rawDiff {
    border-left-color: #dc2626;
    background: rgba(220, 38, 38, 0.08);
  }

  /* Update section */
  .settle-update-section {
    margin-bottom: 10px;
    padding: 10px;
    background: #0c0a09;
    border-radius: 4px;
    border: 1px dashed #44403c;
  }

  .update-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .update-label {
    font-size: 0.8em;
    font-weight: 600;
    color: #fbbf24;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* Settlement preview ghost bar */
  .settle-preview {
    padding: 10px;
    background: #0c0a09;
    border: 1px dashed #292524;
    border-radius: 4px;
    margin-top: 8px;
  }

  .preview-label {
    font-size: 0.7em;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    display: block;
    margin-bottom: 8px;
  }

  .preview-token {
    margin-bottom: 8px;
  }

  .preview-token:last-child {
    margin-bottom: 0;
  }

  .preview-token-label {
    font-size: 0.7em;
    font-weight: 600;
    display: block;
    margin-bottom: 4px;
  }

  .preview-bars {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .preview-bar {
    display: flex;
    height: 8px;
    border-radius: 2px;
    overflow: hidden;
    background: #1c1917;
  }

  .preview-bar.ghost {
    opacity: 0.5;
    border: 1px dashed #fbbf24;
  }

  .preview-segment.out {
    background: #10b981;
    opacity: 0.8;
  }

  .preview-segment.in {
    background: #10b981;
    opacity: 0.6;
  }

  .preview-sep {
    width: 1px;
    background: #666;
  }

  .preview-diff {
    display: flex;
    gap: 12px;
    font-size: 0.65em;
    font-family: monospace;
    color: #888;
    margin-top: 4px;
  }
</style>
