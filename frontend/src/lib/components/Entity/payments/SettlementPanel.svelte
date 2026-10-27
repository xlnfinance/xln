<script lang="ts">
  import { countBatchOps } from "./pending-batch-preview";
  import { requireBigInt } from "#lib/utils/boundary/index.ts";
import type { EntityReadView } from '#lib/components/Entity/core/entity-panel-types.ts';

  import { xlnFunctions } from '../../../stores/xlnStore';
  import type { EntityState } from '#lib/types/ui.ts';
  import type { RuntimeReplica, EnvSnapshot, Profile as GossipProfile } from '@xln/core/api/public/runtime-module';
  import { entityAvatar as resolveEntityAvatar } from '#lib/utils/identity/avatar.ts';
  import ActivityHistoryPanel from './ActivityHistoryPanel.svelte';

  export let entityId: string;
  export let replica: EntityReadView | null = null;
  export let env: RuntimeReplica | EnvSnapshot | null = null;
  export let profiles: GossipProfile[] = [];
  type BatchDetailField = { label: string; value: string };
  type BatchDetailOp = {
    key: string;
    operation: string;
    entities: string[];
    details: BatchDetailField[];
  };
  type JBatchState = NonNullable<EntityState['jBatchState']>;
  type BatchShape = JBatchState['batch'];
  type SettlementLike = {
    leftEntity?: unknown;
    rightEntity?: unknown;
    diffs?: Array<{ leftDiff?: unknown; rightDiff?: unknown }>;
  };

  $: activeXlnFunctions = $xlnFunctions;
  $: activeEnv = env;
  // Settlement must read the same visible entity replica as the rest of the screen.
  // Mixing a second live lookup here causes split-brain UI (Assets sees new reserves, Settle sees old zeroes).
  $: currentReplica = replica ?? null;

  function normalizeEntityId(id: string | null | undefined): string {
    return String(id || '').trim().toLowerCase();
  }

  function formatShortId(id: string): string {
    if (!id) return '';
    if (id.length < 22) return id;
    return `${id.slice(0, 10)}...${id.slice(-6)}`;
  }

  function shortHex(hex: unknown, head = 10, tail = 6): string {
    const value = String(hex || '');
    if (!value) return '—';
    if (value.length <= head + tail + 3) return value;
    return `${value.slice(0, head)}...${value.slice(-tail)}`;
  }

  const toBigInt = (value: unknown): bigint => requireBigInt(value, 'BATCH_AMOUNT_INVALID');

  function tokenLabel(token: unknown): string {
    const tokenIdNum = Number(token || 0);
    if (!Number.isFinite(tokenIdNum) || tokenIdNum <= 0) return `Token #${String(token || 0)}`;
    const tokenInfo = activeXlnFunctions?.getTokenInfo?.(tokenIdNum);
    return tokenInfo?.symbol ? `${tokenInfo.symbol} (#${tokenIdNum})` : `Token #${tokenIdNum}`;
  }

  function tokenAmountLabel(token: unknown, amount: unknown): string {
    const tokenIdNum = Number(token || 0);
    const amountBig = toBigInt(amount);
    if (tokenIdNum > 0 && activeXlnFunctions?.formatTokenAmount) {
      return activeXlnFunctions.formatTokenAmount(tokenIdNum, amountBig);
    }
    return `${amountBig.toString()} ${tokenLabel(token)}`;
  }

  function entityName(entity: string): string {
    const canonical = String(entity || '').trim();
    if (!canonical) return 'Unknown';
    const normalized = normalizeEntityId(canonical);
    if (normalized === normalizeEntityId(entityId)) return 'You';
    for (const profile of profiles) {
      if (normalizeEntityId(profile.entityId) !== normalized) continue;
      const profileName = profile.name.trim();
      if (profileName) return profileName;
    }
    return formatShortId(canonical);
  }

  function entityAvatar(entity: string): string {
    const canonical = String(entity || '').trim();
    if (!canonical) return '';
    return resolveEntityAvatar(activeXlnFunctions, canonical);
  }

  function uniqueEntities(values: Array<unknown>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of values) {
      const value = String(raw || '').trim();
      const normalized = normalizeEntityId(value);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(value);
    }
    return out;
  }

  function isSelfEntity(entity: unknown): boolean {
    const canonical = normalizeEntityId(String(entity || '').trim());
    return !!canonical && canonical === normalizeEntityId(entityId);
  }

  function settlementReserveDelta(op: SettlementLike | null | undefined): bigint {
    const leftIsSelf = isSelfEntity(op?.leftEntity);
    const rightIsSelf = isSelfEntity(op?.rightEntity);
    if (!leftIsSelf && !rightIsSelf) return 0n;

    let delta = 0n;
    for (const diff of Array.isArray(op?.diffs) ? op.diffs : []) {
      if (leftIsSelf) {
        delta += toBigInt(diff?.leftDiff);
      } else if (rightIsSelf) {
        delta += toBigInt(diff?.rightDiff);
      }
    }
    return delta;
  }

  function makeBatchDetailOp(
    key: string,
    operation: string,
    entities: Array<unknown>,
    details: Array<BatchDetailField | null | undefined>,
  ): BatchDetailOp {
    return {
      key,
      operation,
      entities: uniqueEntities(entities),
      details: details.filter(Boolean) as BatchDetailField[],
    };
  }

  function buildBatchDetailOps(batch: BatchShape | undefined | null): BatchDetailOp[] {
    if (!batch || typeof batch !== 'object') return [];
    const reserveIncreaseOps: BatchDetailOp[] = [];
    const reserveDecreaseOps: BatchDetailOp[] = [];
    const neutralOps: BatchDetailOp[] = [];
    const pushOp = (phase: 'increase' | 'decrease' | 'neutral', op: BatchDetailOp): void => {
      if (phase === 'increase') reserveIncreaseOps.push(op);
      else if (phase === 'decrease') reserveDecreaseOps.push(op);
      else neutralOps.push(op);
    };

    for (const [index, op] of (Array.isArray(batch.externalTokenToReserve) ? batch.externalTokenToReserve : []).entries()) {
      pushOp(
        'increase',
        makeBatchDetailOp(
          `externalTokenToReserve-${index}`,
          'ExternalTokenToReserve',
          [op?.entity],
          [
            { label: 'Entity', value: entityName(String(op?.entity || '')) },
            { label: 'Contract', value: shortHex(op?.contractAddress) },
            { label: 'Internal Token', value: tokenLabel(op?.internalTokenId) },
            { label: 'Amount', value: tokenAmountLabel(op?.internalTokenId, op?.amount) },
          ],
        ),
      );
    }

    for (const [index, op] of (Array.isArray(batch.reserveToReserve) ? batch.reserveToReserve : []).entries()) {
      const token = Number(op?.tokenId || 0);
      const isIncrease = isSelfEntity(op?.receivingEntity);
      pushOp(
        isIncrease ? 'increase' : 'decrease',
        makeBatchDetailOp(
          `reserveToReserve-${index}`,
          isIncrease ? 'ReserveToReserve (Inbound)' : 'ReserveToReserve',
          [entityId, op?.receivingEntity],
          [
            { label: 'Token', value: tokenLabel(token) },
            { label: 'Amount', value: tokenAmountLabel(token, op?.amount) },
            { label: 'Receiving Entity', value: entityName(String(op?.receivingEntity || '')) },
          ],
        ),
      );
    }

    for (const [index, op] of (Array.isArray(batch.collateralToReserve) ? batch.collateralToReserve : []).entries()) {
      const token = Number(op?.tokenId || 0);
      pushOp(
        'increase',
        makeBatchDetailOp(
          `collateralToReserve-${index}`,
          'CollateralToReserve',
          [entityId, op?.counterparty],
          [
            { label: 'Token', value: tokenLabel(token) },
            { label: 'Amount', value: tokenAmountLabel(token, op?.amount) },
            { label: 'Counterparty', value: entityName(String(op?.counterparty || '')) },
            { label: 'Nonce', value: String(Number(op?.nonce || 0)) },
            { label: 'Signature', value: shortHex(op?.sig) },
          ],
        ),
      );
    }

    for (const [index, op] of (Array.isArray(batch.settlements) ? batch.settlements : []).entries()) {
      const diffs = Array.isArray(op?.diffs) ? op.diffs : [];
      const diffSummary = diffs
        .map((diff) => {
          const token = Number(diff?.tokenId || 0);
          const left = toBigInt(diff?.leftDiff);
          const right = toBigInt(diff?.rightDiff);
          const collateral = toBigInt(diff?.collateralDiff);
          const ondelta = toBigInt(diff?.ondeltaDiff);
          return `${tokenLabel(token)} left=${left} right=${right} collateral=${collateral} ondelta=${ondelta}`;
        })
        .join(' | ');
      const reserveDelta = settlementReserveDelta(op);
      const phase = reserveDelta > 0n ? 'increase' : reserveDelta < 0n ? 'decrease' : 'neutral';
      const operation = reserveDelta > 0n
        ? 'Settlement (+Reserve)'
        : reserveDelta < 0n
          ? 'Settlement (-Reserve)'
          : 'Settlement';
      pushOp(
        phase,
        makeBatchDetailOp(
          `settlements-${index}`,
          operation,
          [op?.leftEntity, op?.rightEntity],
          [
            { label: 'Left Entity', value: entityName(String(op?.leftEntity || '')) },
            { label: 'Right Entity', value: entityName(String(op?.rightEntity || '')) },
            { label: 'Diffs', value: diffSummary || 'None' },
            { label: 'Nonce', value: String(Number(op?.nonce || 0)) },
            { label: 'Signature', value: shortHex(op?.sig) },
          ],
        ),
      );
    }

    for (const [index, op] of (Array.isArray(batch.reserveToCollateral) ? batch.reserveToCollateral : []).entries()) {
      const token = Number(op?.tokenId || 0);
      const pairs = Array.isArray(op?.pairs) ? op.pairs : [];
      if (pairs.length === 0) {
        pushOp(
          'decrease',
          makeBatchDetailOp(
            `reserveToCollateral-${index}-empty`,
            'ReserveToCollateral',
            [op?.receivingEntity],
            [
              { label: 'Token', value: tokenLabel(token) },
              { label: 'Receiving Entity', value: entityName(String(op?.receivingEntity || '')) },
              { label: 'Pairs', value: 'None' },
            ],
          ),
        );
      } else {
        for (const [pairIndex, pair] of pairs.entries()) {
          pushOp(
            'decrease',
            makeBatchDetailOp(
              `reserveToCollateral-${index}-${pairIndex}`,
              'ReserveToCollateral',
              [op?.receivingEntity, pair?.entity],
              [
                { label: 'Token', value: tokenLabel(token) },
                { label: 'Amount', value: tokenAmountLabel(token, pair?.amount) },
                { label: 'Receiving Entity', value: entityName(String(op?.receivingEntity || '')) },
                { label: 'Counterparty', value: entityName(String(pair?.entity || '')) },
              ],
            ),
          );
        }
      }
    }

    for (const [index, op] of (Array.isArray(batch.disputeStarts) ? batch.disputeStarts : []).entries()) {
      pushOp(
        'neutral',
        makeBatchDetailOp(
          `disputeStarts-${index}`,
          'DisputeStart',
          [entityId, op?.counterentity],
          [
            { label: 'Counterparty', value: entityName(String(op?.counterentity || '')) },
            { label: 'Nonce', value: String(Number(op?.nonce || 0)) },
            { label: 'Proof Body Hash', value: shortHex(op?.proofbodyHash) },
            { label: 'Starter Args', value: shortHex(op?.starterInitialArguments) },
            { label: 'Counter Args', value: shortHex(op?.starterCounterArguments) },
          ],
        ),
      );
    }

    for (const [index, op] of (Array.isArray(batch.counterDisputes) ? batch.counterDisputes : []).entries()) {
      pushOp(
        'neutral',
        makeBatchDetailOp(
          `counterDisputes-${index}`,
          'CounterDispute',
          [entityId, op?.counterentity],
          [
            { label: 'Counterparty', value: entityName(String(op?.counterentity || '')) },
            { label: 'Selected nonce', value: String(op?.counterNonce || 0) },
            { label: 'Proof hash', value: shortHex(op?.initialProofbodyHash) },
          ],
        ),
      );
    }

    for (const [index, op] of (Array.isArray(batch.disputeFinalizations) ? batch.disputeFinalizations : []).entries()) {
      pushOp(
        'neutral',
        makeBatchDetailOp(
          `disputeFinalizations-${index}`,
          'DisputeFinalize',
          [entityId, op?.counterentity],
          [
            { label: 'Counterparty', value: entityName(String(op?.counterentity || '')) },
            { label: 'Initial Nonce', value: String(Number(op?.initialNonce || 0)) },
            { label: 'Final Nonce', value: String(Number(op?.finalNonce || 0)) },
            { label: 'Starter Side', value: op?.startedByLeft ? 'Left' : 'Right' },
            { label: 'Initial Proof Hash', value: shortHex(op?.initialProofbodyHash) },
            { label: 'Cooperative', value: op?.cooperative ? 'Yes' : 'No' },
          ],
        ),
      );
    }

    for (const [index, op] of (Array.isArray(batch.reserveToExternalToken) ? batch.reserveToExternalToken : []).entries()) {
      pushOp(
        'decrease',
        makeBatchDetailOp(
          `reserveToExternalToken-${index}`,
          'ReserveToExternalToken',
          [entityId, op?.receivingEntity],
          [
            { label: 'Receiving Entity', value: entityName(String(op?.receivingEntity || '')) },
            { label: 'Token', value: tokenLabel(op?.tokenId) },
            { label: 'Amount', value: tokenAmountLabel(op?.tokenId, op?.amount) },
          ],
        ),
      );
    }

    for (const [index, op] of (Array.isArray(batch.revealSecrets) ? batch.revealSecrets : []).entries()) {
      pushOp(
        'neutral',
        makeBatchDetailOp(
          `revealSecrets-${index}`,
          'RevealSecret',
          [],
          [
            { label: 'Transformer', value: shortHex(op?.transformer) },
            { label: 'Secret', value: shortHex(op?.secret) },
          ],
        ),
      );
    }

    for (const [index, registration] of (Array.isArray(batch.hashLadderRegistrations) ? batch.hashLadderRegistrations : []).entries()) {
      pushOp(
        'neutral',
        makeBatchDetailOp(
          `hashLadderRegistrations-${index}`,
          'HashLadderRegistration',
          [entityId, String(registration?.counterpartyEntity || '')],
          [
            { label: 'Account peer', value: shortHex(String(registration?.counterpartyEntity || '')) },
            { label: 'Role', value: registration?.targetRole ? 'Target' : 'Source' },
            { label: 'Fill ratio', value: String(registration?.witness?.fillRatio || 0) },
          ],
        ),
      );
    }

    return [...reserveIncreaseOps, ...reserveDecreaseOps, ...neutralOps];
  }

  function batchSummary(batch: BatchShape | undefined | null): Array<{ label: string; count: number }> {
    return [
      { label: 'ExternalTokenToReserve', count: Number(batch?.externalTokenToReserve?.length || 0) },
      { label: 'CollateralToReserve', count: Number(batch?.collateralToReserve?.length || 0) },
      { label: 'Settlement', count: Number(batch?.settlements?.length || 0) },
      { label: 'ReserveToReserve', count: Number(batch?.reserveToReserve?.length || 0) },
      { label: 'ReserveToCollateral', count: Number(batch?.reserveToCollateral?.length || 0) },
      { label: 'ReserveToExternalToken', count: Number(batch?.reserveToExternalToken?.length || 0) },
      { label: 'DisputeStart', count: Number(batch?.disputeStarts?.length || 0) },
      { label: 'CounterDispute', count: Number(batch?.counterDisputes?.length || 0) },
      { label: 'DisputeFinalize', count: Number(batch?.disputeFinalizations?.length || 0) },
      { label: 'RevealSecret', count: Number(batch?.revealSecrets?.length || 0) },
      { label: 'HashLadderRegistration', count: Number(batch?.hashLadderRegistrations?.length || 0) },
    ].filter((entry) => entry.count > 0);
  }

  $: jBatchState = currentReplica?.state?.jBatchState ?? null;
  $: jBatch = jBatchState?.batch || null;
  $: sentBatch = jBatchState?.sentBatch || null;
  $: pendingOps = countBatchOps(jBatch);
  $: hasSentBatch = !!sentBatch;
  $: hasDraftBatch = pendingOps > 0;
  $: hasAnyBatch = hasSentBatch || hasDraftBatch;
  $: pendingSummary = batchSummary(jBatch);
  let batchPreviewError = '';
  $: draftDetailOps = (() => {
    batchPreviewError = '';
    try { return buildBatchDetailOps(jBatch); }
    catch (error) { batchPreviewError = error instanceof Error ? error.message : String(error); return []; }
  })();
</script>

<div class="settlement-panel">
  {#if batchPreviewError}<p role="alert">Batch preview unavailable: {batchPreviewError}</p>{/if}
  {#if hasAnyBatch}
  <div class="batch-card" class:has-pending={hasAnyBatch}>
    <div class="batch-header">
      <div>
        <div class="batch-title">Batch</div>
        <div class="batch-subtitle">
          {#if hasSentBatch}
            Sent. Waiting for finalization.
          {:else if hasDraftBatch}
            Draft contains {pendingOps} operation{pendingOps === 1 ? '' : 's'}.
          {:else}
            Ready.
          {/if}
        </div>
      </div>
      <div class="batch-status-meta">Durable history</div>
    </div>

    <div class="draft-batch" class:locked={hasSentBatch}>
      <div class="preview-label">
        {#if hasSentBatch}
          Queued draft
        {:else}
          Draft
        {/if}
      </div>
    {#if hasDraftBatch}
      <div class="batch-summary">
        {#each pendingSummary as item}
          <span class="summary-chip">{item.label}: {item.count}</span>
        {/each}
      </div>
      {#if draftDetailOps.length > 0}
        <div class="batch-ops-grid">
          {#each draftDetailOps as op (op.key)}
            <article class="batch-op-card">
              <div class="batch-op-title">{op.operation}</div>
              {#if op.entities.length > 0}
                <div class="batch-op-entities">
                  {#each op.entities as opEntityId}
                    {@const identity = {
                      id: String(opEntityId || ''),
                      short: formatShortId(String(opEntityId || '')),
                      name: entityName(String(opEntityId || '')),
                      avatar: entityAvatar(String(opEntityId || '')),
                    }}
                    <div class="entity-chip" title={identity.id}>
                      {#if identity.avatar}
                        <img class="entity-chip-avatar" src={identity.avatar} alt="" />
                      {:else}
                        <span class="entity-chip-avatar placeholder">{identity.name.slice(0, 1).toUpperCase()}</span>
                      {/if}
                      <span class="entity-chip-name">{identity.name}</span>
                      <code class="entity-chip-id">{identity.short}</code>
                    </div>
                  {/each}
                </div>
              {/if}
              <div class="batch-op-details">
                {#each op.details as field}
                  <div class="batch-op-field">
                    <span class="batch-op-field-label">{field.label}</span>
                    <span class="batch-op-field-value">{field.value}</span>
                  </div>
                {/each}
              </div>
            </article>
          {/each}
        </div>
      {/if}
    {:else}
      <div class="batch-empty">
        {#if hasSentBatch}
          Draft queue is empty. You can keep queueing new ops while the submitted batch is in-flight.
        {:else}
          Queue actions below, then sign and broadcast.
        {/if}
      </div>
    {/if}
    </div>

  </div>
  {/if}

  <ActivityHistoryPanel {entityId} runtimeId={activeEnv?.runtimeId} />

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

  .batch-status-meta {
    font-size: 11px;
    color: #9ca3af;
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
    padding: 4px 10px;
    font-size: 10px;
    font-weight: 600;
    color: #e7e5e4;
    background: #111111;
    border: 1px solid #292524;
    letter-spacing: 0.02em;
  }

  .batch-ops-grid {
    margin-top: 10px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 10px;
  }

  .batch-op-card {
    border: 1px solid #302d2a;
    background: linear-gradient(180deg, #141414 0%, #101010 100%);
    border-radius: 10px;
    padding: 10px;
  }

  .batch-op-title {
    color: #f3f4f6;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .batch-op-entities {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .entity-chip {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    border: 1px solid #2f2f2f;
    border-radius: 8px;
    background: #0d0d0d;
    padding: 5px 7px;
  }

  .entity-chip-avatar {
    width: 22px;
    height: 22px;
    border-radius: 6px;
    border: 1px solid #3f3f46;
    object-fit: cover;
  }

  .entity-chip-avatar.placeholder {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #d6d3d1;
    font-size: 11px;
    font-weight: 700;
    background: #1f1f22;
  }

  .entity-chip-name {
    min-width: 0;
    color: #e7e5e4;
    font-size: 11px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .entity-chip-id {
    color: #9ca3af;
    font-size: 10px;
    font-family: 'JetBrains Mono', monospace;
  }

  .batch-op-details {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .batch-op-field {
    display: grid;
    grid-template-columns: 110px minmax(0, 1fr);
    gap: 8px;
    align-items: baseline;
  }

  .batch-op-field-label {
    color: #a1a1aa;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .batch-op-field-value {
    color: #f5f5f5;
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
    word-break: break-word;
  }

  .preview-label {
    font-size: 10px;
    font-weight: 700;
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .batch-empty {
    margin-top: 10px;
    border-radius: 8px;
    border: 1px dashed #3f3f46;
    color: #a8a29e;
    padding: 10px;
    font-size: 12px;
  }

  @media (max-width: 900px) {

  }
</style>
