<script lang="ts">
  import { getXLN, xlnEnvironment, replicas, enqueueEntityInputs, xlnFunctions } from '../../stores/xlnStore';
  import { isLive as globalIsLive } from '../../stores/timeStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
  import EntityInput from '../shared/EntityInput.svelte';
  import TokenSelect from '../shared/TokenSelect.svelte';

  export let entityId: string;
  export let contacts: Array<{ name: string; entityId: string }> = [];
  export let prefill: { tokenId?: number; id: number } | null = null;

  // Context
  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
  const contextReplicas = entityEnv?.eReplicas;
  const contextXlnFunctions = entityEnv?.xlnFunctions;
  const contextEnv = entityEnv?.env;
  const contextIsLive = entityEnv?.isLive;

  // Stores
  $: activeReplicas = contextReplicas ? $contextReplicas : $replicas;
  $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;
  $: activeEnv = contextEnv ? $contextEnv : $xlnEnvironment;
  $: activeIsLive = contextIsLive ? $contextIsLive : $globalIsLive;

  // Form state
  let counterpartyEntityId = '';
  let recipientEntityId = '';
  let tokenId = 1;
  let action: 'fund' | 'withdraw' | 'transfer' | 'dispute' = 'fund';
  let amount = '';
  let disputeReason = '';
  let sending = false;
  let lastPrefillId = 0;

  // Self-transfer check
  $: isSelfTransfer = recipientEntityId && recipientEntityId.toLowerCase() === entityId.toLowerCase();

  function normalizeEntityId(id: string | null | undefined): string {
    return String(id || '').trim().toLowerCase();
  }

  // Resolve selected entity replica, then derive account list from bilateral accounts.
  $: currentEntityReplica = (() => {
    if (!activeReplicas || !entityId) return null;
    const targetNorm = normalizeEntityId(entityId);
    for (const [key, replica] of activeReplicas.entries() as IterableIterator<[string, any]>) {
      const [replicaEntityId] = String(key || '').split(':');
      if (normalizeEntityId(replicaEntityId) === targetNorm) return replica;
    }
    return null;
  })();

  $: accountEntityIds = (() => {
    const accounts = currentEntityReplica?.state?.accounts;
    if (!accounts || typeof accounts.keys !== 'function') return [];
    return Array.from(accounts.keys()).map((id) => String(id)).sort();
  })();

  // Transfer can target broader network; account-bound actions must use accountEntityIds only.
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

  // Format short ID
  function formatShortId(id: string): string {
    return id || '';
  }

  function resolveSignerId(env: any): string {
    return activeXlnFunctions?.resolveEntityProposerId?.(env, entityId, 'settlement-panel')
      || requireSignerIdForEntity(env, entityId, 'settlement-panel');
  }

  function isRuntimeEnv(value: unknown): value is { eReplicas: Map<string, unknown>; jReplicas: Map<string, unknown> } {
    if (!value || typeof value !== 'object') return false;
    const obj = value as { eReplicas?: unknown; jReplicas?: unknown };
    return obj.eReplicas instanceof Map && obj.jReplicas instanceof Map;
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

  function toChainAmountString(amountUnits: bigint): string {
    if (amountUnits <= 0n) throw new Error('Amount must be greater than zero');
    const value = amountUnits.toString(10);
    if (!/^\d+$/.test(value)) throw new Error('Amount encoding failed');
    return value;
  }

  // Get pending batch
  $: jBatch = (() => {
    if (!activeReplicas || !entityId) return null;
    const keys = Array.from(activeReplicas.keys()) as string[];
    const replicaKey = keys.find((k) => k.startsWith(entityId + ':'));
    if (!replicaKey) return null;
    const replica = activeReplicas.get(replicaKey);
    return (replica?.state as any)?.jBatchState?.batch || null;
  })();

  // Count pending operations
  $: pendingOps = jBatch ? (
    (jBatch.reserveToCollateral?.length || 0) +
    (jBatch.collateralToReserve?.length || 0) +
    (jBatch.settlements?.length || 0) +
    (jBatch.reserveToReserve?.length || 0)
  ) : 0;

  // Show batch panel
  let showBatch = false;

  // Broadcast batch
  async function broadcastBatch() {
    if (!jBatch || pendingOps === 0) return;
    sending = true;
    try {
      const xln = await getXLN();
      if (!xln) throw new Error('XLN not initialized');

      const jurisdictions = await xln.getAvailableJurisdictions();
      const jurisdictionConfig = jurisdictions[0];
      if (!jurisdictionConfig) throw new Error('No jurisdiction available');

      // Find signer
      const env = activeEnv;
      if (!env) throw new Error('Environment not ready');
      const signerId = resolveSignerId(env);

      console.log('[On-J] Broadcasting batch:', jBatch);
      const result = await xln.submitProcessBatch(jurisdictionConfig, entityId, jBatch, signerId);
      console.log('[On-J] Batch confirmed:', result);
      showBatch = false;
    } catch (error) {
      console.error('[On-J] Batch failed:', error);
      alert(`Batch failed: ${(error as Error)?.message}`);
    } finally {
      sending = false;
    }
  }

  async function submit() {
    sending = true;
    try {
      await getXLN();
      const env = activeEnv;
      if (!env) throw new Error('Environment not ready');
      if (!isRuntimeEnv(env)) throw new Error('Runtime environment not available');
      if (!activeIsLive) throw new Error('On-chain actions are only available in LIVE mode');

      const signerId = resolveSignerId(env);

      let entityTx: any;

      if (action === 'fund') {
        if (!counterpartyEntityId) throw new Error('Select an account to fund');
        const parsedAmount = parsePositiveAmount(amount, tokenId);
        entityTx = {
          type: 'deposit_collateral' as const,
          data: {
            counterpartyId: counterpartyEntityId,
            tokenId,
            amount: parsedAmount,
          },
        };
        console.log('[On-J] Fund:', amount, 'to', formatShortId(counterpartyEntityId));

      } else if (action === 'withdraw') {
        if (!counterpartyEntityId) throw new Error('Select account to withdraw from');
        const parsedAmount = parsePositiveAmount(amount, tokenId);
        entityTx = {
          type: 'requestWithdrawal' as const,
          data: {
            counterpartyEntityId,
            tokenId,
            amount: parsedAmount,
          },
        };
        console.log('[On-J] Withdraw:', amount, 'from', formatShortId(counterpartyEntityId));

      } else if (action === 'transfer') {
        const recipient = recipientEntityId || counterpartyEntityId;
        if (!recipient) throw new Error('Select a recipient');
        if (recipient.toLowerCase() === entityId.toLowerCase()) throw new Error('Cannot transfer to yourself');

        const xln = await getXLN();
        if (!xln) throw new Error('XLN not initialized');

        const jurisdictions = await xln.getAvailableJurisdictions();
        const jurisdictionConfig = jurisdictions[0];
        if (!jurisdictionConfig) throw new Error('No jurisdiction available');

        const amountWei = toChainAmountString(parsePositiveAmount(amount, tokenId));
        console.log('[On-J] Transfer:', amount, '(', amountWei, 'wei) to', formatShortId(recipient));
        const result = await xln.submitReserveToReserve(jurisdictionConfig, entityId, recipient, tokenId, amountWei);
        console.log('[On-J] Confirmed:', result.txHash);

        amount = '';
        sending = false;
        return;

      } else if (action === 'dispute') {
        if (!counterpartyEntityId) throw new Error('Select account to dispute');
        if (!confirm('Start dispute now? This will freeze the bilateral account until finalized.')) return;
        entityTx = {
          type: 'startDispute' as const,
          data: {
            counterpartyEntityId,
            reason: disputeReason || 'Dispute initiated',
          },
        };
        console.log('[On-J] Dispute with:', formatShortId(counterpartyEntityId));
      }

      await enqueueEntityInputs(env, [{
        entityId,
        signerId,
        entityTxs: [entityTx],
      }]);

      console.log('[On-J] Submitted');
      amount = '';
      disputeReason = '';
    } catch (error) {
      console.error('[On-J] Failed:', error);
      alert(`Failed: ${(error as Error)?.message}`);
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

  // Apply prefill when requested (token only; account chosen by user)
  $: if (prefill && prefill.id !== lastPrefillId) {
    lastPrefillId = prefill.id;
    if (typeof prefill.tokenId === 'number') {
      tokenId = prefill.tokenId;
    }
    action = 'fund';
  }
</script>

<div class="settlement-panel">
  <!-- Pending Batch Banner (always visible when pending) -->
  {#if pendingOps > 0}
    <div class="pending-banner" class:expanded={showBatch}>
      <button class="banner-toggle" on:click={() => showBatch = !showBatch}>
        <span class="pending-icon">⏳</span>
        <span class="pending-text">{pendingOps} pending {pendingOps === 1 ? 'operation' : 'operations'}</span>
        <span class="chevron-icon" class:open={showBatch}>▼</span>
      </button>

      {#if showBatch && jBatch}
        <div class="batch-preview">
          {#if jBatch.reserveToReserve?.length > 0}
            <div class="preview-group">
              <span class="preview-label">R2R Transfers</span>
              {#each jBatch.reserveToReserve as r2r}
                <div class="preview-item">→ {formatShortId(r2r.receivingEntity)}: {r2r.amount.toString()}</div>
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
          {#if jBatch.settlements?.length > 0}
            <div class="preview-group">
              <span class="preview-label">Settlements</span>
              {#each jBatch.settlements as settle}
                <div class="preview-item">⟷ {formatShortId(settle.leftEntity)}</div>
              {/each}
            </div>
          {/if}
        </div>

        <button class="btn-sign-broadcast" on:click={broadcastBatch} disabled={sending}>
          {sending ? 'Signing & Broadcasting...' : 'Sign & Broadcast'}
        </button>
      {/if}
    </div>
  {/if}

  <!-- Action Tabs -->
  <div class="action-tabs">
    <button class="tab" class:active={action === 'fund'} on:click={() => action = 'fund'} disabled={sending}>
      Fund
    </button>
    <button class="tab" class:active={action === 'withdraw'} on:click={() => action = 'withdraw'} disabled={sending}>
      Withdraw
    </button>
    <button class="tab" class:active={action === 'transfer'} on:click={() => action = 'transfer'} disabled={sending}>
      Transfer
    </button>
    <button class="tab dispute" class:active={action === 'dispute'} on:click={() => action = 'dispute'} disabled={sending}>
      Dispute
    </button>
  </div>

  <!-- Description -->
  <p class="action-desc">
    {#if action === 'fund'}
      Add collateral to a bilateral account
    {:else if action === 'withdraw'}
      Remove collateral (requires counterparty approval)
    {:else if action === 'transfer'}
      Send directly on-chain to any entity
    {:else}
      Start on-chain dispute with counterparty
    {/if}
  </p>

  <!-- Entity Selection -->
  {#if action === 'transfer'}
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
      label={action === 'dispute' ? 'Counterparty' : 'Account'}
      value={counterpartyEntityId}
      entities={accountEntityIds}
      {contacts}
      excludeId={entityId}
      placeholder={action === 'dispute' ? 'Select counterparty...' : 'Select account...'}
      disabled={sending}
      on:change={handleAccountChange}
    />
    {#if accountEntityIds.length === 0}
      <p class="error-hint">No accounts found. Open one in Accounts first.</p>
    {/if}
  {/if}

  <!-- Dispute Reason -->
  {#if action === 'dispute'}
    <div class="field">
      <label>Reason</label>
      <input
        type="text"
        bind:value={disputeReason}
        placeholder="Describe the dispute..."
        disabled={sending}
      />
    </div>
  {:else}
    <!-- Amount & Token -->
    <div class="row">
      <div class="amount-field">
        <label>Amount</label>
        <input
          type="text"
          bind:value={amount}
          placeholder="1000000"
          disabled={sending}
        />
      </div>
      <TokenSelect
        label="Token"
        value={tokenId}
        disabled={sending}
        on:change={handleTokenChange}
      />
    </div>
  {/if}

  <!-- Submit -->
  <button
    class="btn-submit"
    class:dispute={action === 'dispute'}
    on:click={submit}
    disabled={sending || Boolean(action === 'dispute'
      ? !counterpartyEntityId
      : (!amount || (action === 'transfer' ? (!recipientEntityId || isSelfTransfer) : !counterpartyEntityId)))}
  >
    {#if sending}
      Processing...
    {:else if action === 'fund'}
      Fund Account
    {:else if action === 'withdraw'}
      Request Withdrawal
    {:else if action === 'transfer'}
      Send Transfer
    {:else}
      Start Dispute
    {/if}
  </button>

  <!-- Tip: 2-step flow -->
  <p class="two-step-note">
    All on-chain actions are queued in a batch. Review and sign before broadcasting.
  </p>
</div>

<style>
  .settlement-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  /* Pending Banner */
  .pending-banner {
    background: linear-gradient(135deg, #422006 0%, #78350f 100%);
    border: 1px solid #92400e;
    border-radius: 10px;
    overflow: hidden;
  }

  .pending-banner.expanded {
    border-color: #fbbf24;
  }

  .banner-toggle {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px;
    background: transparent;
    border: none;
    color: #fef3c7;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }

  .pending-icon {
    font-size: 16px;
  }

  .pending-text {
    flex: 1;
    text-align: left;
  }

  .chevron-icon {
    font-size: 10px;
    transition: transform 0.15s;
    color: #fbbf24;
  }

  .chevron-icon.open {
    transform: rotate(180deg);
  }

  .batch-preview {
    padding: 0 16px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .preview-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .preview-label {
    font-size: 10px;
    font-weight: 600;
    color: #fcd34d;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .preview-item {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #fef3c7;
    padding: 4px 8px;
    background: rgba(0,0,0,0.2);
    border-radius: 4px;
  }

  .btn-sign-broadcast {
    width: calc(100% - 32px);
    margin: 4px 16px 16px;
    padding: 14px;
    background: linear-gradient(135deg, #15803d, #166534);
    border: none;
    border-radius: 8px;
    color: #dcfce7;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-sign-broadcast:hover:not(:disabled) {
    background: linear-gradient(135deg, #16a34a, #15803d);
  }

  .btn-sign-broadcast:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .two-step-note {
    margin: 0;
    font-size: 11px;
    color: #57534e;
    font-style: italic;
    text-align: center;
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

  .tab.dispute.active {
    background: #450a0a;
    color: #f87171;
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

  .field, .amount-field {
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

  input:disabled {
    opacity: 0.5;
  }

  .btn-submit {
    padding: 14px;
    background: linear-gradient(135deg, #92400e, #78350f);
    border: none;
    border-radius: 8px;
    color: #fef3c7;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-submit:hover:not(:disabled) {
    background: linear-gradient(135deg, #a3580f, #92400e);
  }

  .btn-submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-submit.dispute {
    background: linear-gradient(135deg, #991b1b, #7f1d1d);
    color: #fecaca;
  }

  .btn-submit.dispute:hover:not(:disabled) {
    background: linear-gradient(135deg, #b91c1c, #991b1b);
  }

  .error-hint {
    margin: 4px 0 0;
    font-size: 11px;
    color: #ef4444;
  }

</style>
