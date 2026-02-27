<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getXLN, xlnEnvironment, replicas, enqueueEntityInputs, xlnFunctions } from '../../stores/xlnStore';
  import { isLive as globalIsLive } from '../../stores/timeStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
  import type { EntityReplica } from '$lib/types/ui';
  import EntityInput from '../shared/EntityInput.svelte';
  import TokenSelect from '../shared/TokenSelect.svelte';

  export let entityId: string;
  export let contacts: Array<{ name: string; entityId: string }> = [];
  export let replica: EntityReplica | null = null;
  export let prefill: { tokenId?: number; id: number } | null = null;

  type Action = 'fund' | 'withdraw' | 'transfer' | 'dispute';
  type GasPreset = 'standard' | 'fast' | 'urgent' | 'custom';

  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
  const contextReplicas = entityEnv?.eReplicas;
  const contextXlnFunctions = entityEnv?.xlnFunctions;
  const contextEnv = entityEnv?.env;
  const contextIsLive = entityEnv?.isLive;

  $: activeReplicas = contextReplicas ? $contextReplicas : $replicas;
  $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;
  $: activeEnv = contextEnv ? $contextEnv : $xlnEnvironment;
  $: activeIsLive = contextIsLive ? $contextIsLive : $globalIsLive;

  let counterpartyEntityId = '';
  let recipientEntityId = '';
  let tokenId = 1;
  let action: Action = 'fund';
  let amount = '';
  let sending = false;
  let lastPrefillId = 0;

  let gasPreset: GasPreset = 'standard';
  let customMaxFeeGwei = '';
  let customPriorityFeeGwei = '';
  let suggestedBaseMaxFeeWei = 0n;
  let suggestedBasePriorityWei = 0n;
  let gasLoading = false;

  let liveJHeight = 0;
  let liveJTimer: ReturnType<typeof setInterval> | null = null;

  function normalizeEntityId(id: string | null | undefined): string {
    return String(id || '').trim().toLowerCase();
  }

  function isRuntimeEnv(value: unknown): value is { eReplicas: Map<string, unknown>; jReplicas: Map<string, unknown> } {
    if (!value || typeof value !== 'object') return false;
    const obj = value as { eReplicas?: unknown; jReplicas?: unknown };
    return obj.eReplicas instanceof Map && obj.jReplicas instanceof Map;
  }

  function resolveSignerId(env: any): string {
    return activeXlnFunctions?.resolveEntityProposerId?.(env, entityId, 'settlement-panel')
      || requireSignerIdForEntity(env, entityId, 'settlement-panel');
  }

  function parseDecimalToUnits(input: string, decimals: number): bigint {
    const trimmed = input.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error('Invalid amount format');
    const [wholeRaw, fracRaw = ''] = trimmed.split('.');
    const whole = BigInt(wholeRaw || '0');
    const fracPadded = (fracRaw + '0'.repeat(decimals)).slice(0, decimals);
    const frac = fracPadded ? BigInt(fracPadded) : 0n;
    return whole * (10n ** BigInt(decimals)) + frac;
  }

  function parsePositiveAmount(raw: string, token: number): bigint {
    const trimmed = raw.trim();
    if (!trimmed) throw new Error('Amount is required');
    const tokenInfo = activeXlnFunctions?.getTokenInfo?.(token);
    const decimals = Number.isFinite(tokenInfo?.decimals) ? Number(tokenInfo.decimals) : 18;
    const parsed = parseDecimalToUnits(trimmed, decimals);
    if (parsed <= 0n) throw new Error('Amount must be greater than zero');
    return parsed;
  }

  function formatShortId(id: string): string {
    if (!id) return '';
    if (id.length < 22) return id;
    return `${id.slice(0, 10)}...${id.slice(-6)}`;
  }

  function formatWeiToGwei(wei: bigint): string {
    const base = 1_000_000_000n;
    const whole = wei / base;
    const frac2 = ((wei % base) * 100n) / base;
    return `${whole.toString()}.${frac2.toString().padStart(2, '0')}`;
  }

  function formatClock(ms: number | undefined): string {
    if (!ms || !Number.isFinite(ms)) return '—';
    return new Date(ms).toLocaleTimeString();
  }

  function scaleWei(value: bigint, bps: number): bigint {
    if (bps <= 0) return value;
    return (value * BigInt(bps) + 9_999n) / 10_000n;
  }

  async function refreshLiveJHeight(): Promise<void> {
    const jReplicas = activeEnv?.jReplicas;
    if (!(jReplicas instanceof Map) || jReplicas.size === 0) return;
    const activeJKey = (activeEnv as any)?.activeJurisdiction;
    const activeJReplica = activeJKey ? jReplicas.get(activeJKey) : null;
    const anyJReplica = activeJReplica ?? Array.from(jReplicas.values())[0];
    const provider = (anyJReplica as any)?.jadapter?.provider;
    if (!provider || typeof provider.getBlockNumber !== 'function') return;
    try {
      const blockNumber = Number(await provider.getBlockNumber());
      if (Number.isFinite(blockNumber)) liveJHeight = blockNumber;
    } catch {
      // Non-fatal.
    }
  }

  async function refreshGasSuggestions(): Promise<void> {
    const jReplicas = activeEnv?.jReplicas;
    if (!(jReplicas instanceof Map) || jReplicas.size === 0) return;
    const activeJKey = (activeEnv as any)?.activeJurisdiction;
    const activeJReplica = activeJKey ? jReplicas.get(activeJKey) : null;
    const anyJReplica = activeJReplica ?? Array.from(jReplicas.values())[0];
    const provider = (anyJReplica as any)?.jadapter?.provider;
    if (!provider || typeof provider.getFeeData !== 'function') return;

    gasLoading = true;
    try {
      const feeData = await provider.getFeeData();
      const maxFee = typeof feeData?.maxFeePerGas === 'bigint' ? feeData.maxFeePerGas : 0n;
      const priority = typeof feeData?.maxPriorityFeePerGas === 'bigint' ? feeData.maxPriorityFeePerGas : 0n;
      if (maxFee > 0n) suggestedBaseMaxFeeWei = maxFee;
      if (priority > 0n) suggestedBasePriorityWei = priority;
      if (!customMaxFeeGwei && suggestedBaseMaxFeeWei > 0n) customMaxFeeGwei = formatWeiToGwei(suggestedBaseMaxFeeWei);
      if (!customPriorityFeeGwei && suggestedBasePriorityWei > 0n) customPriorityFeeGwei = formatWeiToGwei(suggestedBasePriorityWei);
    } catch {
      // Keep defaults.
    } finally {
      gasLoading = false;
    }
  }

  function buildFeeOverrides(): { gasBumpBps?: number; maxFeePerGasWei?: string; maxPriorityFeePerGasWei?: string } | null {
    if (gasPreset === 'custom') {
      const out: { maxFeePerGasWei?: string; maxPriorityFeePerGasWei?: string } = {};
      if (customMaxFeeGwei.trim()) {
        out.maxFeePerGasWei = parseDecimalToUnits(customMaxFeeGwei, 9).toString();
      }
      if (customPriorityFeeGwei.trim()) {
        out.maxPriorityFeePerGasWei = parseDecimalToUnits(customPriorityFeeGwei, 9).toString();
      }
      return Object.keys(out).length > 0 ? out : null;
    }

    const multiplierBps = gasPreset === 'urgent' ? 15_000 : gasPreset === 'fast' ? 12_000 : 10_000;
    const maxFee = suggestedBaseMaxFeeWei > 0n ? scaleWei(suggestedBaseMaxFeeWei, multiplierBps) : 0n;
    const priority = suggestedBasePriorityWei > 0n ? scaleWei(suggestedBasePriorityWei, multiplierBps) : 0n;
    if (maxFee <= 0n && priority <= 0n) return null;
    const out: { maxFeePerGasWei?: string; maxPriorityFeePerGasWei?: string } = {};
    if (maxFee > 0n) out.maxFeePerGasWei = maxFee.toString();
    if (priority > 0n) out.maxPriorityFeePerGasWei = priority.toString();
    return out;
  }

  $: isSelfTransfer = recipientEntityId && recipientEntityId.toLowerCase() === entityId.toLowerCase();

  $: accountEntityIds = (() => {
    const accounts = replica?.state?.accounts;
    if (!accounts || typeof accounts.keys !== 'function') return [];
    const unique = new Set<string>();
    for (const id of accounts.keys() as Iterable<string>) {
      const value = String(id || '').trim();
      if (value) unique.add(value);
    }
    return Array.from(unique.values()).sort();
  })();

  $: transferEntityOptions = (() => {
    const ids = new Map<string, string>();
    const add = (raw: string | null | undefined) => {
      const canonical = String(raw || '').trim();
      const norm = normalizeEntityId(canonical);
      if (!norm || norm === normalizeEntityId(entityId)) return;
      if (!ids.has(norm)) ids.set(norm, canonical);
    };

    for (const accountId of accountEntityIds) add(accountId);
    for (const key of activeReplicas?.keys?.() || []) add(String(key).split(':')[0]);
    for (const profile of activeEnv?.gossip?.getProfiles?.() || []) add((profile as any)?.entityId);

    return Array.from(ids.values()).sort();
  })();

  function countBatchOps(batch: any): number {
    if (!batch) return 0;
    return (
      (batch.reserveToCollateral?.length || 0) +
      (batch.collateralToReserve?.length || 0) +
      (batch.settlements?.length || 0) +
      (batch.reserveToReserve?.length || 0) +
      (batch.disputeStarts?.length || 0) +
      (batch.disputeFinalizations?.length || 0) +
      (batch.externalTokenToReserve?.length || 0) +
      (batch.reserveToExternalToken?.length || 0) +
      (batch.revealSecrets?.length || 0)
    );
  }

  function batchSummary(batch: any): Array<{ label: string; count: number }> {
    return [
      { label: 'R2C', count: Number(batch?.reserveToCollateral?.length || 0) },
      { label: 'C2R', count: Number(batch?.collateralToReserve?.length || 0) },
      { label: 'Settle', count: Number(batch?.settlements?.length || 0) },
      { label: 'R2R', count: Number(batch?.reserveToReserve?.length || 0) },
      { label: 'Dispute Start', count: Number(batch?.disputeStarts?.length || 0) },
      { label: 'Dispute Finalize', count: Number(batch?.disputeFinalizations?.length || 0) },
      { label: 'Ext→Reserve', count: Number(batch?.externalTokenToReserve?.length || 0) },
      { label: 'Reserve→Ext', count: Number(batch?.reserveToExternalToken?.length || 0) },
      { label: 'Reveal', count: Number(batch?.revealSecrets?.length || 0) },
    ].filter((entry) => entry.count > 0);
  }

  $: jBatchState = (replica?.state as any)?.jBatchState || null;
  $: jBatch = jBatchState?.batch || null;
  $: sentBatch = jBatchState?.sentBatch || null;
  $: pendingOps = countBatchOps(jBatch);
  $: sentOps = countBatchOps(sentBatch?.batch);
  $: hasSentBatch = !!sentBatch;
  $: hasDraftBatch = pendingOps > 0;
  $: hasAnyBatch = hasSentBatch || hasDraftBatch;
  $: canBroadcastDraft = hasDraftBatch && !hasSentBatch;
  $: pendingSummary = batchSummary(jBatch);
  $: sentSummary = batchSummary(sentBatch?.batch);

  $: selectedAccount = counterpartyEntityId ? replica?.state?.accounts?.get?.(counterpartyEntityId) : null;
  $: selectedAccountActiveDispute = (selectedAccount as any)?.activeDispute ?? null;
  $: selectedAccountStatus = String((selectedAccount as any)?.status || '');
  $: selectedDisputeTimeout = Number(selectedAccountActiveDispute?.disputeTimeout || 0);
  $: selectedDisputeBlocksLeft = selectedAccountActiveDispute
    ? Math.max(0, selectedDisputeTimeout - Math.max(Number(replica?.state?.lastFinalizedJHeight || 0), Number(liveJHeight || 0)))
    : 0;

  async function clearBatch() {
    if (!hasAnyBatch) return;
    if (!confirm('Clear current draft and sent batch state?')) return;

    sending = true;
    try {
      const env = activeEnv;
      if (!env || !isRuntimeEnv(env)) throw new Error('Runtime environment not available');
      if (!activeIsLive) throw new Error('On-chain actions are only available in LIVE mode');
      const signerId = resolveSignerId(env);

      await enqueueEntityInputs(env, [{
        entityId,
        signerId,
        entityTxs: [{ type: 'j_clear_batch', data: { reason: 'manual-clear-from-ui' } }],
      }]);
    } catch (err) {
      alert(`Clear failed: ${(err as Error)?.message}`);
    } finally {
      sending = false;
    }
  }

  async function broadcastBatch() {
    if (!canBroadcastDraft) return;
    sending = true;
    try {
      const env = activeEnv;
      if (!env || !isRuntimeEnv(env)) throw new Error('Runtime environment not available');
      if (!activeIsLive) throw new Error('On-chain actions are only available in LIVE mode');

      await getXLN();
      const signerId = resolveSignerId(env);
      const feeOverrides = buildFeeOverrides();

      await enqueueEntityInputs(env, [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'j_broadcast',
          data: feeOverrides ? { feeOverrides } : {},
        }],
      }]);

      console.log('[On-J] j_broadcast queued');
    } catch (error) {
      console.error('[On-J] Batch failed:', error);
      alert(`Batch failed: ${(error as Error)?.message}`);
    } finally {
      sending = false;
    }
  }

  async function rebroadcastSentBatch() {
    if (!hasSentBatch) return;
    sending = true;
    try {
      const env = activeEnv;
      if (!env || !isRuntimeEnv(env)) throw new Error('Runtime environment not available');
      if (!activeIsLive) throw new Error('On-chain actions are only available in LIVE mode');
      const signerId = resolveSignerId(env);

      const gasBumpBps = gasPreset === 'urgent' ? 5_000 : gasPreset === 'fast' ? 2_000 : gasPreset === 'custom' ? 3_000 : 1_000;
      await enqueueEntityInputs(env, [{
        entityId,
        signerId,
        entityTxs: [{ type: 'j_rebroadcast', data: { gasBumpBps } }],
      }]);
      console.log(`[On-J] j_rebroadcast queued (bump=${gasBumpBps}bps)`);
    } catch (error) {
      console.error('[On-J] Rebroadcast failed:', error);
      alert(`Rebroadcast failed: ${(error as Error)?.message}`);
    } finally {
      sending = false;
    }
  }

  async function submitAction() {
    sending = true;
    try {
      await getXLN();
      const env = activeEnv;
      if (!env || !isRuntimeEnv(env)) throw new Error('Runtime environment not available');
      if (!activeIsLive) throw new Error('On-chain actions are only available in LIVE mode');

      const signerId = resolveSignerId(env);
      const parsedAmount = parsePositiveAmount(amount, tokenId);

      let entityTx: any;
      if (action === 'fund') {
        if (!counterpartyEntityId) throw new Error('Select an account to fund');
        entityTx = {
          type: 'deposit_collateral' as const,
          data: {
            counterpartyId: counterpartyEntityId,
            tokenId,
            amount: parsedAmount,
          },
        };
      } else if (action === 'withdraw') {
        if (!counterpartyEntityId) throw new Error('Select account to withdraw from');
        entityTx = {
          type: 'requestWithdrawal' as const,
          data: {
            counterpartyEntityId,
            tokenId,
            amount: parsedAmount,
          },
        };
      } else {
        const recipient = recipientEntityId || counterpartyEntityId;
        if (!recipient) throw new Error('Select a recipient');
        if (recipient.toLowerCase() === entityId.toLowerCase()) throw new Error('Cannot transfer to yourself');
        entityTx = {
          type: 'reserve_to_reserve' as const,
          data: {
            toEntityId: recipient,
            tokenId,
            amount: parsedAmount,
          },
        };
      }

      await enqueueEntityInputs(env, [{
        entityId,
        signerId,
        entityTxs: [entityTx],
      }]);
      amount = '';
    } catch (error) {
      console.error('[On-J] Failed:', error);
      alert(`Failed: ${(error as Error)?.message}`);
    } finally {
      sending = false;
    }
  }

  async function startDispute() {
    if (!counterpartyEntityId) {
      alert('Select account first');
      return;
    }
    if (!confirm('Start dispute for selected account?')) return;

    sending = true;
    try {
      const env = activeEnv;
      if (!env || !isRuntimeEnv(env)) throw new Error('Runtime environment not available');
      if (!activeIsLive) throw new Error('On-chain actions are only available in LIVE mode');
      const signerId = resolveSignerId(env);

      await enqueueEntityInputs(env, [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'disputeStart',
          data: {
            counterpartyEntityId,
            description: 'entity-settle-dispute-start',
          },
        }],
      }]);
    } catch (error) {
      alert(`Dispute start failed: ${(error as Error)?.message}`);
    } finally {
      sending = false;
    }
  }

  async function finalizeDispute() {
    if (!counterpartyEntityId) {
      alert('Select account first');
      return;
    }

    sending = true;
    try {
      const env = activeEnv;
      if (!env || !isRuntimeEnv(env)) throw new Error('Runtime environment not available');
      if (!activeIsLive) throw new Error('On-chain actions are only available in LIVE mode');
      const signerId = resolveSignerId(env);

      await enqueueEntityInputs(env, [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'disputeFinalize',
          data: {
            counterpartyEntityId,
            description: 'entity-settle-dispute-finalize',
          },
        }],
      }]);
    } catch (error) {
      alert(`Dispute finalize failed: ${(error as Error)?.message}`);
    } finally {
      sending = false;
    }
  }

  function handleAccountChange(e: CustomEvent) {
    counterpartyEntityId = e.detail.value;
  }

  function handleRecipientChange(e: CustomEvent) {
    recipientEntityId = e.detail.value;
  }

  function handleTokenChange(e: CustomEvent) {
    tokenId = e.detail.value;
  }

  $: if (prefill && prefill.id !== lastPrefillId) {
    lastPrefillId = prefill.id;
    if (typeof prefill.tokenId === 'number') tokenId = prefill.tokenId;
    action = 'fund';
  }

  $: gasPreview = (() => {
    const pick = (preset: GasPreset): { maxFeeWei: bigint; maxPriorityWei: bigint } => {
      if (preset === 'custom') {
        let maxFeeWei = 0n;
        let maxPriorityWei = 0n;
        try {
          if (customMaxFeeGwei.trim()) maxFeeWei = parseDecimalToUnits(customMaxFeeGwei, 9);
          if (customPriorityFeeGwei.trim()) maxPriorityWei = parseDecimalToUnits(customPriorityFeeGwei, 9);
        } catch {
          return { maxFeeWei: 0n, maxPriorityWei: 0n };
        }
        return { maxFeeWei, maxPriorityWei };
      }
      const bps = preset === 'urgent' ? 15_000 : preset === 'fast' ? 12_000 : 10_000;
      return {
        maxFeeWei: suggestedBaseMaxFeeWei > 0n ? scaleWei(suggestedBaseMaxFeeWei, bps) : 0n,
        maxPriorityWei: suggestedBasePriorityWei > 0n ? scaleWei(suggestedBasePriorityWei, bps) : 0n,
      };
    };
    return pick(gasPreset);
  })();

  $: if (activeIsLive) {
    void refreshLiveJHeight();
  }

  onMount(() => {
    liveJTimer = setInterval(() => {
      void refreshLiveJHeight();
      if (hasAnyBatch) void refreshGasSuggestions();
    }, 5000);
    void refreshLiveJHeight();
    void refreshGasSuggestions();
  });

  onDestroy(() => {
    if (liveJTimer) clearInterval(liveJTimer);
  });
</script>

<div class="settlement-panel">
  <div class="batch-card" class:has-pending={hasAnyBatch}>
    <div class="batch-header">
      <div>
        <div class="batch-title">On-Chain Batch Lifecycle</div>
        <div class="batch-subtitle">
          {#if hasSentBatch && hasDraftBatch}
            Broadcasted batch in-flight + {pendingOps} draft operation{pendingOps === 1 ? '' : 's'}
          {:else if hasSentBatch}
            Broadcasted batch in-flight ({sentOps} operation{sentOps === 1 ? '' : 's'})
          {:else if hasDraftBatch}
            Draft batch: {pendingOps} operation{pendingOps === 1 ? '' : 's'}
          {:else}
            No pending on-chain operations
          {/if}
        </div>
      </div>
      {#if hasSentBatch}
        <span class="batch-pill">Awaiting Finalization</span>
      {:else if hasDraftBatch}
        <span class="batch-pill">Needs Signature</span>
      {/if}
    </div>

    {#if hasSentBatch}
      <div class="sent-batch">
        <div class="sent-meta">
          <span>Nonce #{sentBatch.entityNonce}</span>
          <span>Hash {sentBatch.batchHash?.slice(0, 10)}...</span>
          <span>Attempts {sentBatch.submitAttempts}</span>
          <span>Last submit {formatClock(sentBatch.lastSubmittedAt)}</span>
        </div>
        {#if sentSummary.length > 0}
          <div class="batch-summary">
            {#each sentSummary as item}
              <span class="summary-chip">{item.label}: {item.count}</span>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <div class="draft-batch" class:locked={hasSentBatch}>
      <div class="preview-label">Current Draft Batch</div>
    {#if hasDraftBatch}
      <div class="batch-summary">
        {#each pendingSummary as item}
          <span class="summary-chip">{item.label}: {item.count}</span>
        {/each}
      </div>
      <div class="batch-preview">
        {#if jBatch.disputeStarts?.length > 0}
          <div class="preview-group">
            <span class="preview-label">Dispute Starts</span>
            {#each jBatch.disputeStarts as start}
              <div class="preview-item">⚔ {formatShortId(start.counterentity)}</div>
            {/each}
          </div>
        {/if}
        {#if jBatch.disputeFinalizations?.length > 0}
          <div class="preview-group">
            <span class="preview-label">Dispute Finalizations</span>
            {#each jBatch.disputeFinalizations as fin}
              <div class="preview-item">⚖ {formatShortId(fin.counterentity)}</div>
            {/each}
          </div>
        {/if}
        {#if jBatch.reserveToCollateral?.length > 0}
          <div class="preview-group">
            <span class="preview-label">R2C Deposits</span>
            {#each jBatch.reserveToCollateral as r2c}
              <div class="preview-item">↓ {formatShortId(r2c.receivingEntity)}</div>
            {/each}
          </div>
        {/if}
        {#if jBatch.collateralToReserve?.length > 0}
          <div class="preview-group">
            <span class="preview-label">C2R Withdrawals</span>
            {#each jBatch.collateralToReserve as c2r}
              <div class="preview-item">↑ {formatShortId(c2r.counterparty)}</div>
            {/each}
          </div>
        {/if}
        {#if jBatch.reserveToReserve?.length > 0}
          <div class="preview-group">
            <span class="preview-label">R2R Transfers</span>
            {#each jBatch.reserveToReserve as r2r}
              <div class="preview-item">→ {formatShortId(r2r.receivingEntity)}: {r2r.amount.toString()}</div>
            {/each}
          </div>
        {/if}
      </div>
    {:else}
      <div class="batch-empty">
        {#if hasSentBatch}
          Draft is empty. You can keep queueing new ops while sent batch is in-flight.
        {:else}
          Queue actions below, then sign & broadcast.
        {/if}
      </div>
    {/if}
    </div>

    {#if hasAnyBatch}
      <div class="gas-card">
        <div class="gas-header">
          <span>Gas</span>
          <button class="btn-refresh-gas" on:click={() => refreshGasSuggestions()} disabled={gasLoading}>
            {gasLoading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
        <div class="gas-presets">
          <button class:active={gasPreset === 'standard'} on:click={() => gasPreset = 'standard'}>Standard</button>
          <button class:active={gasPreset === 'fast'} on:click={() => gasPreset = 'fast'}>Fast</button>
          <button class:active={gasPreset === 'urgent'} on:click={() => gasPreset = 'urgent'}>Urgent</button>
          <button class:active={gasPreset === 'custom'} on:click={() => gasPreset = 'custom'}>Custom</button>
        </div>
        {#if gasPreset === 'custom'}
          <div class="gas-custom-row">
            <label>
              Max Fee (gwei)
              <input type="text" bind:value={customMaxFeeGwei} placeholder="e.g. 35" />
            </label>
            <label>
              Priority Fee (gwei)
              <input type="text" bind:value={customPriorityFeeGwei} placeholder="e.g. 2" />
            </label>
          </div>
        {/if}
        <div class="gas-preview">
          <span>maxFee: {gasPreview.maxFeeWei > 0n ? `${formatWeiToGwei(gasPreview.maxFeeWei)} gwei` : 'auto'}</span>
          <span>priority: {gasPreview.maxPriorityWei > 0n ? `${formatWeiToGwei(gasPreview.maxPriorityWei)} gwei` : 'auto'}</span>
        </div>
      </div>
    {/if}

    <div class="batch-actions">
      <button class="btn-clear" data-testid="settle-clear-batch" on:click={clearBatch} disabled={sending || !hasAnyBatch}>Clear</button>
      {#if hasSentBatch}
        <button class="btn-sign-broadcast" data-testid="settle-rebroadcast" on:click={rebroadcastSentBatch} disabled={sending}>
          {sending ? 'Rebroadcasting...' : 'Rebroadcast (+gas bump)'}
        </button>
      {/if}
      <button class="btn-sign-broadcast" data-testid="settle-sign-broadcast" on:click={broadcastBatch} disabled={sending || !canBroadcastDraft}>
        {sending ? 'Signing & Broadcasting...' : 'Sign & Broadcast'}
      </button>
    </div>
    {#if hasSentBatch && hasDraftBatch}
      <p class="batch-empty">Draft queued. Broadcast unlocks automatically once sent batch finalizes.</p>
    {/if}
  </div>

  <div class="action-tabs">
    <button class="tab" class:active={action === 'fund'} on:click={() => action = 'fund'} disabled={sending}>Fund</button>
    <button class="tab" class:active={action === 'withdraw'} on:click={() => action = 'withdraw'} disabled={sending}>Withdraw</button>
    <button class="tab" class:active={action === 'transfer'} on:click={() => action = 'transfer'} disabled={sending}>Transfer</button>
    <button class="tab" class:active={action === 'dispute'} on:click={() => action = 'dispute'} disabled={sending}>Dispute</button>
  </div>

  <p class="action-desc">
    {#if action === 'fund'}
      Queue reserve-to-collateral into selected account.
    {:else if action === 'withdraw'}
      Queue collateral withdrawal request for selected account.
    {:else if action === 'dispute'}
      Queue dispute start/finalize for selected account.
    {:else}
      Queue reserve-to-reserve transfer to another entity.
    {/if}
  </p>

  {#if action === 'dispute'}
    <div class="dispute-inline">
      <EntityInput
        label="Account"
        value={counterpartyEntityId}
        entities={accountEntityIds}
        {contacts}
        excludeId={entityId}
        placeholder="Select account..."
        disabled={sending}
        on:change={handleAccountChange}
      />
      {#if counterpartyEntityId && !selectedAccount}
        <p class="error-hint">Account not found in entity state.</p>
      {/if}
      {#if selectedAccountActiveDispute}
        <p class="dispute-state">Active dispute: {selectedDisputeBlocksLeft} block{selectedDisputeBlocksLeft === 1 ? '' : 's'} left (until J#{selectedDisputeTimeout}).</p>
      {:else if selectedAccountStatus === 'disputed'}
        <p class="dispute-state finalized">Finalized disputed account. Use Open Account section to reopen.</p>
      {/if}
      <div class="dispute-actions">
        <button
          class="btn-dispute-start"
          data-testid="settle-dispute-start"
          on:click={startDispute}
          disabled={sending || !counterpartyEntityId || !!selectedAccountActiveDispute || selectedAccountStatus === 'disputed'}
        >
          Start Dispute
        </button>
        <button
          class="btn-dispute-finalize"
          data-testid="settle-dispute-finalize"
          on:click={finalizeDispute}
          disabled={sending || !counterpartyEntityId || !selectedAccountActiveDispute}
        >
          Finalize Dispute
        </button>
      </div>
    </div>
  {:else if action === 'transfer'}
    <EntityInput
      label="Recipient"
      value={recipientEntityId}
      entities={transferEntityOptions}
      {contacts}
      excludeId={entityId}
      placeholder="Select recipient..."
      disabled={sending}
      on:change={handleRecipientChange}
    />
    {#if isSelfTransfer}
      <p class="error-hint">Cannot transfer to yourself</p>
    {/if}
  {:else}
    <EntityInput
      label="Account"
      value={counterpartyEntityId}
      entities={accountEntityIds}
      {contacts}
      excludeId={entityId}
      placeholder="Select account..."
      disabled={sending}
      on:change={handleAccountChange}
    />
    {#if accountEntityIds.length === 0}
      <p class="error-hint">No accounts found. Open one in Accounts first.</p>
    {/if}
  {/if}

  {#if action !== 'dispute'}
    <div class="row">
      <div class="amount-field">
        <label>Amount</label>
        <input type="text" bind:value={amount} placeholder="100" disabled={sending} />
      </div>
      <TokenSelect label="Token" value={tokenId} disabled={sending} on:change={handleTokenChange} />
    </div>

    <button
      data-testid="settle-queue-action"
      class="btn-submit"
      on:click={submitAction}
      disabled={sending || !amount || Boolean(action === 'transfer' ? (!recipientEntityId || isSelfTransfer) : !counterpartyEntityId)}
    >
      {#if sending}
        Processing...
      {:else if action === 'fund'}
        Queue Fund (R2C)
      {:else if action === 'withdraw'}
        Queue Withdraw (C2R)
      {:else}
        Queue Transfer (R2R)
      {/if}
    </button>
  {/if}

  <p class="two-step-note">All on-chain actions queue in batch. Review above, then Sign & Broadcast.</p>
</div>

<style>
  .settlement-panel {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .batch-card {
    background: #18181b;
    border: 1px solid #292524;
    border-radius: 12px;
    padding: 14px;
  }

  .batch-card.has-pending {
    border-color: rgba(248, 113, 113, 0.45);
    box-shadow: 0 0 0 1px rgba(185, 28, 28, 0.3) inset;
  }

  .batch-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .batch-title {
    font-size: 13px;
    font-weight: 700;
    color: #f3f4f6;
  }

  .batch-subtitle {
    font-size: 11px;
    color: #9ca3af;
  }

  .batch-pill {
    background: #7f1d1d;
    color: #fecaca;
    border: 1px solid rgba(248, 113, 113, 0.4);
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    padding: 3px 8px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .sent-batch {
    margin-top: 10px;
    border: 1px solid rgba(248, 113, 113, 0.35);
    border-radius: 8px;
    background: rgba(127, 29, 29, 0.16);
    padding: 10px;
  }

  .sent-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 11px;
    color: #fecaca;
    font-family: 'JetBrains Mono', monospace;
  }

  .draft-batch {
    margin-top: 10px;
    border: 1px solid #292524;
    border-radius: 8px;
    background: #151310;
    padding: 10px;
  }

  .draft-batch.locked {
    border-color: rgba(251, 191, 36, 0.35);
    box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.14) inset;
  }

  .batch-summary {
    margin-top: 10px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .summary-chip {
    border-radius: 999px;
    padding: 3px 8px;
    font-size: 10px;
    font-weight: 600;
    color: #e7e5e4;
    background: #1c1917;
    border: 1px solid #292524;
  }

  .batch-preview {
    margin-top: 10px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 10px;
  }

  .preview-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px;
    border: 1px solid #292524;
    border-radius: 8px;
    background: #151310;
  }

  .preview-label {
    font-size: 10px;
    font-weight: 700;
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .preview-item {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #e7e5e4;
    background: #0c0a09;
    border: 1px solid #292524;
    border-radius: 6px;
    padding: 4px 6px;
  }

  .gas-card {
    margin-top: 10px;
    padding: 10px;
    border-radius: 10px;
    border: 1px solid #292524;
    background: #151310;
  }

  .gas-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    color: #d6d3d1;
    margin-bottom: 8px;
  }

  .btn-refresh-gas {
    border: 1px solid #3f3f46;
    background: #18181b;
    color: #d6d3d1;
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 11px;
    cursor: pointer;
  }

  .btn-refresh-gas:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .gas-presets {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
  }

  .gas-presets button {
    border: 1px solid #3f3f46;
    background: #18181b;
    color: #a8a29e;
    border-radius: 6px;
    padding: 6px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .gas-presets button.active {
    border-color: #f59e0b;
    color: #fbbf24;
    background: rgba(245, 158, 11, 0.12);
  }

  .gas-custom-row {
    margin-top: 8px;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .gas-custom-row label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    color: #a8a29e;
    text-transform: none;
    letter-spacing: normal;
  }

  .gas-custom-row input {
    padding: 8px;
    border-radius: 6px;
    border: 1px solid #3f3f46;
    background: #18181b;
    color: #e7e5e4;
  }

  .gas-preview {
    margin-top: 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 11px;
    color: #d6d3d1;
  }

  .batch-actions {
    margin-top: 12px;
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }

  .btn-clear,
  .btn-sign-broadcast {
    border-radius: 8px;
    border: 1px solid transparent;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    padding: 10px 14px;
  }

  .btn-clear {
    background: rgba(127, 29, 29, 0.18);
    border-color: rgba(248, 113, 113, 0.4);
    color: #fecaca;
  }

  .btn-sign-broadcast {
    background: linear-gradient(135deg, #b45309, #92400e);
    border-color: rgba(251, 191, 36, 0.4);
    color: #fffbeb;
  }

  .btn-clear:disabled,
  .btn-sign-broadcast:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .batch-empty {
    margin-top: 10px;
    border-radius: 8px;
    border: 1px dashed #3f3f46;
    color: #a8a29e;
    padding: 10px;
    font-size: 12px;
  }

  .dispute-inline {
    border: 1px solid #292524;
    border-radius: 10px;
    background: #151310;
    padding: 10px;
  }

  .dispute-state {
    margin: 8px 0 0;
    color: #fda4af;
    font-size: 12px;
  }

  .dispute-state.finalized {
    color: #fb7185;
  }

  .dispute-actions {
    margin-top: 10px;
    display: flex;
    gap: 8px;
  }

  .btn-dispute-start,
  .btn-dispute-finalize {
    border-radius: 8px;
    border: 1px solid rgba(248, 113, 113, 0.4);
    background: rgba(127, 29, 29, 0.18);
    color: #fecaca;
    padding: 9px 12px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }

  .btn-dispute-finalize {
    border-color: rgba(251, 191, 36, 0.45);
    background: rgba(120, 53, 15, 0.2);
    color: #fde68a;
  }

  .btn-dispute-start:disabled,
  .btn-dispute-finalize:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .action-tabs {
    display: flex;
    gap: 4px;
    background: #0c0a09;
    border-radius: 8px;
    padding: 4px;
  }

  .tab {
    flex: 1;
    padding: 10px 8px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: #78716c;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .tab:hover:not(:disabled):not(.active) {
    background: #1c1917;
    color: #a8a29e;
  }

  .tab.active {
    background: #422006;
    color: #fbbf24;
  }

  .tab:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .action-desc {
    margin: 0;
    font-size: 12px;
    color: #57534e;
    line-height: 1.4;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 12px;
    align-items: end;
  }

  .amount-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  label {
    font-size: 11px;
    font-weight: 500;
    color: #78716c;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  input {
    padding: 12px 14px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 8px;
    color: #e7e5e4;
    font-size: 14px;
    font-family: inherit;
    width: 100%;
    box-sizing: border-box;
  }

  input:focus {
    outline: none;
    border-color: #fbbf24;
  }

  input::placeholder {
    color: #57534e;
  }

  .btn-submit {
    padding: 14px;
    background: linear-gradient(135deg, #92400e, #78350f);
    border: none;
    border-radius: 8px;
    color: #fef3c7;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }

  .btn-submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error-hint {
    margin: 4px 0 0;
    font-size: 11px;
    color: #ef4444;
  }

  .two-step-note {
    margin: 0;
    font-size: 11px;
    color: #6b7280;
    text-align: center;
  }

  @media (max-width: 900px) {
    .batch-preview {
      grid-template-columns: 1fr;
    }

    .gas-presets {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .gas-custom-row {
      grid-template-columns: 1fr;
    }

    .row {
      grid-template-columns: 1fr;
    }

    .batch-actions {
      flex-direction: column;
    }
  }
</style>
