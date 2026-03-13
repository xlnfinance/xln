<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getXLN, xlnEnvironment, replicas, enqueueEntityInputs, xlnFunctions } from '../../stores/xlnStore';
  import { isLive as globalIsLive } from '../../stores/timeStore';
  import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
  import type { EntityReplica, EntityTx, AccountMachine, EntityState } from '$lib/types/ui';
  import type { Env } from '$types';
  import EntityInput from '../shared/EntityInput.svelte';
  import TokenSelect from '../shared/TokenSelect.svelte';

  export let entityId: string;
  export let contacts: Array<{ name: string; entityId: string }> = [];
  export let replica: EntityReplica | null = null;
  type Action = 'transfer' | 'dispute' | 'history';
  type GasPreset = 'standard' | 'fast' | 'urgent' | 'custom';
  type BatchDetailField = { label: string; value: string };
  type BatchDetailOp = {
    key: string;
    operation: string;
    entities: string[];
    details: BatchDetailField[];
  };
  type RuntimeEnv = Env;
  type JBatchState = NonNullable<EntityState['jBatchState']>;
  type BatchShape = JBatchState['batch'];
  type CompletedBatch = NonNullable<EntityState['batchHistory']>[number];
  type BatchHistoryRow = { entry: CompletedBatch; details: BatchDetailOp[]; key: string };
  type ActiveDispute = NonNullable<AccountMachine['activeDispute']>;
  type FeeOverrides = { gasBumpBps?: number; maxFeePerGasWei?: string; maxPriorityFeePerGasWei?: string };
  type RuntimeJReplica = RuntimeEnv['jReplicas'] extends Map<string, infer Replica> ? Replica : never;
  type PendingSettleEntityTx = Extract<EntityTx, { type: 'reserve_to_reserve' }>;

  $: activeReplicas = $replicas;
  $: activeXlnFunctions = $xlnFunctions;
  $: activeEnv = $xlnEnvironment;
  $: activeIsLive = $globalIsLive;
  $: currentReplica = (() => {
    const liveReplica = activeEnv?.eReplicas instanceof Map ? activeEnv.eReplicas.get(entityId) : null;
    return liveReplica ?? replica;
  })();

  let counterpartyEntityId = '';
  let recipientEntityId = '';
  let tokenId = 1;
  let action: Action = 'dispute';
  let amount = '';
  let sending = false;

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

  function isRuntimeEnv(value: unknown): value is RuntimeEnv {
    if (!value || typeof value !== 'object') return false;
    const obj = value as { eReplicas?: unknown; jReplicas?: unknown; runtimeInput?: unknown };
    return obj.eReplicas instanceof Map && obj.jReplicas instanceof Map;
  }

  function resolveSignerId(env: RuntimeEnv): string {
    return activeXlnFunctions?.resolveEntityProposerId?.(env, entityId, 'settlement-panel')
      || requireSignerIdForEntity(env, entityId, 'settlement-panel');
  }

  function parseDecimalToUnits(input: string, decimals: number): bigint {
    const trimmed = input.trim();
    if (!/^(?:\d+|\d+\.\d*|\.\d+)$/.test(trimmed)) throw new Error('Invalid amount format');
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

  function formatTokenInputAmount(amount: bigint, decimals: number): string {
    if (amount <= 0n) return '';
    const divisor = 10n ** BigInt(decimals);
    const whole = amount / divisor;
    const frac = amount % divisor;
    if (frac === 0n) return whole.toString();
    return `${whole.toString()}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
  }

  function getTokenDecimals(currentTokenId: number): number {
    const tokenInfo = activeXlnFunctions?.getTokenInfo?.(currentTokenId);
    return Number.isFinite(tokenInfo?.decimals) ? Number(tokenInfo?.decimals) : 18;
  }

  function formatInlineMaxHint(amountBig: bigint, currentTokenId: number): string {
    if (amountBig <= 0n) return '0';
    return formatTokenInputAmount(amountBig, getTokenDecimals(currentTokenId));
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

  function toBigInt(value: unknown): bigint {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return BigInt(Math.trunc(value));
    if (typeof value === 'string' && value.trim()) {
      try {
        return BigInt(value);
      } catch {
        return 0n;
      }
    }
    return 0n;
  }

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
    for (const contact of contacts || []) {
      if (normalizeEntityId(contact.entityId) === normalized && String(contact.name || '').trim()) {
        return String(contact.name).trim();
      }
    }
    const profiles = activeEnv?.gossip?.getProfiles?.() || [];
    for (const profile of profiles) {
      if (normalizeEntityId(profile.entityId) !== normalized) continue;
      const profileName = profile.name.trim();
      if (profileName) return profileName;
    }
    const formattedId = activeXlnFunctions?.formatEntityId?.(canonical);
    return String(formattedId || formatShortId(canonical));
  }

  function entityAvatar(entity: string): string {
    const canonical = String(entity || '').trim();
    if (!canonical) return '';
    return activeXlnFunctions?.generateEntityAvatar?.(canonical) || '';
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
    const ops: BatchDetailOp[] = [];

    for (const [index, op] of (Array.isArray(batch.reserveToCollateral) ? batch.reserveToCollateral : []).entries()) {
      const token = Number(op?.tokenId || 0);
      const pairs = Array.isArray(op?.pairs) ? op.pairs : [];
      if (pairs.length === 0) {
        ops.push(
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
          ops.push(
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

    for (const [index, op] of (Array.isArray(batch.collateralToReserve) ? batch.collateralToReserve : []).entries()) {
      const token = Number(op?.tokenId || 0);
      ops.push(
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

    for (const [index, op] of (Array.isArray(batch.reserveToReserve) ? batch.reserveToReserve : []).entries()) {
      const token = Number(op?.tokenId || 0);
      ops.push(
        makeBatchDetailOp(
          `reserveToReserve-${index}`,
          'ReserveToReserve',
          [entityId, op?.receivingEntity],
          [
            { label: 'Token', value: tokenLabel(token) },
            { label: 'Amount', value: tokenAmountLabel(token, op?.amount) },
            { label: 'Receiving Entity', value: entityName(String(op?.receivingEntity || '')) },
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
      ops.push(
        makeBatchDetailOp(
          `settlements-${index}`,
          'Settlement',
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

    for (const [index, op] of (Array.isArray(batch.disputeStarts) ? batch.disputeStarts : []).entries()) {
      ops.push(
        makeBatchDetailOp(
          `disputeStarts-${index}`,
          'DisputeStart',
          [entityId, op?.counterentity],
          [
            { label: 'Counterparty', value: entityName(String(op?.counterentity || '')) },
            { label: 'Nonce', value: String(Number(op?.nonce || 0)) },
            { label: 'Proof Body Hash', value: shortHex(op?.proofbodyHash) },
            { label: 'Initial Arguments', value: shortHex(op?.initialArguments) },
          ],
        ),
      );
    }

    for (const [index, op] of (Array.isArray(batch.disputeFinalizations) ? batch.disputeFinalizations : []).entries()) {
      ops.push(
        makeBatchDetailOp(
          `disputeFinalizations-${index}`,
          'DisputeFinalize',
          [entityId, op?.counterentity],
          [
            { label: 'Counterparty', value: entityName(String(op?.counterentity || '')) },
            { label: 'Initial Nonce', value: String(Number(op?.initialNonce || 0)) },
            { label: 'Final Nonce', value: String(Number(op?.finalNonce || 0)) },
            { label: 'Dispute Until Block', value: String(Number(op?.disputeUntilBlock || 0)) },
            { label: 'Initial Proof Hash', value: shortHex(op?.initialProofbodyHash) },
            { label: 'Cooperative', value: op?.cooperative ? 'Yes' : 'No' },
          ],
        ),
      );
    }

    for (const [index, op] of (Array.isArray(batch.externalTokenToReserve) ? batch.externalTokenToReserve : []).entries()) {
      ops.push(
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

    for (const [index, op] of (Array.isArray(batch.reserveToExternalToken) ? batch.reserveToExternalToken : []).entries()) {
      ops.push(
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
      ops.push(
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

    for (const [index, op] of (Array.isArray(batch.flashloans) ? batch.flashloans : []).entries()) {
      ops.push(
        makeBatchDetailOp(
          `flashloans-${index}`,
          'Flashloan',
          [entityId],
          [
            { label: 'Token', value: tokenLabel(op?.tokenId) },
            { label: 'Amount', value: tokenAmountLabel(op?.tokenId, op?.amount) },
          ],
        ),
      );
    }

    return ops;
  }

  function formatWeiToGwei(wei: bigint): string {
    const base = 1_000_000_000n;
    const whole = wei / base;
    const frac2 = ((wei % base) * 100n) / base;
    return `${whole.toString()}.${frac2.toString().padStart(2, '0')}`;
  }

  function formatDateTime(ms: number | undefined): string {
    if (!ms || !Number.isFinite(ms)) return '—';
    return new Date(ms).toLocaleString();
  }

  function scaleWei(value: bigint, bps: number): bigint {
    if (bps <= 0) return value;
    return (value * BigInt(bps) + 9_999n) / 10_000n;
  }

  async function refreshLiveJHeight(): Promise<void> {
    const jReplicas = activeEnv?.jReplicas;
    if (!(jReplicas instanceof Map) || jReplicas.size === 0) return;
    const activeJKey = activeEnv?.activeJurisdiction;
    const activeJReplica = activeJKey ? jReplicas.get(activeJKey) : null;
    const anyJReplica: RuntimeJReplica | undefined = activeJReplica ?? Array.from(jReplicas.values())[0];
    const provider = anyJReplica?.jadapter?.provider;
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
    const activeJKey = activeEnv?.activeJurisdiction;
    const activeJReplica = activeJKey ? jReplicas.get(activeJKey) : null;
    const anyJReplica: RuntimeJReplica | undefined = activeJReplica ?? Array.from(jReplicas.values())[0];
    const provider = anyJReplica?.jadapter?.provider;
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
    const accounts = currentReplica?.state?.accounts;
    if (!accounts || typeof accounts.keys !== 'function') return [];
    const unique = new Set<string>();
    for (const id of accounts.keys() as Iterable<string>) {
      const value = String(id || '').trim();
      if (value) unique.add(value);
    }
    return Array.from(unique.values());
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
    for (const profile of activeEnv?.gossip?.getProfiles?.() || []) add(profile.entityId);

    return Array.from(ids.values());
  })();

  function countBatchOps(batch: BatchShape | undefined | null): number {
    if (!batch) return 0;
    return (
      (batch.flashloans?.length || 0) +
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

  function batchSummary(batch: BatchShape | undefined | null): Array<{ label: string; count: number }> {
    return [
      { label: 'Flashloan', count: Number(batch?.flashloans?.length || 0) },
      { label: 'ReserveToCollateral', count: Number(batch?.reserveToCollateral?.length || 0) },
      { label: 'CollateralToReserve', count: Number(batch?.collateralToReserve?.length || 0) },
      { label: 'Settlement', count: Number(batch?.settlements?.length || 0) },
      { label: 'ReserveToReserve', count: Number(batch?.reserveToReserve?.length || 0) },
      { label: 'DisputeStart', count: Number(batch?.disputeStarts?.length || 0) },
      { label: 'DisputeFinalize', count: Number(batch?.disputeFinalizations?.length || 0) },
      { label: 'ExternalTokenToReserve', count: Number(batch?.externalTokenToReserve?.length || 0) },
      { label: 'ReserveToExternalToken', count: Number(batch?.reserveToExternalToken?.length || 0) },
      { label: 'RevealSecret', count: Number(batch?.revealSecrets?.length || 0) },
    ].filter((entry) => entry.count > 0);
  }

  $: jBatchState = currentReplica?.state?.jBatchState ?? null;
  $: jBatch = jBatchState?.batch || null;
  $: sentBatch = jBatchState?.sentBatch || null;
  $: batchHistory = (() => {
    const history = currentReplica?.state?.batchHistory;
    if (!Array.isArray(history)) return [] as CompletedBatch[];
    return [...history].reverse();
  })();
  $: pendingOps = countBatchOps(jBatch);
  $: sentOps = countBatchOps(sentBatch?.batch);
  $: hasSentBatch = !!sentBatch;
  $: hasDraftBatch = pendingOps > 0;
  $: hasAnyBatch = hasSentBatch || hasDraftBatch;
  $: canBroadcastDraft = !hasSentBatch && hasDraftBatch;
  $: pendingSummary = batchSummary(jBatch);
  $: draftDetailOps = buildBatchDetailOps(jBatch);
  $: batchHistoryRows = batchHistory.map((entry, index): BatchHistoryRow => ({
    entry,
    details: buildBatchDetailOps(entry?.batch),
    key: String(entry?.txHash || `${entry?.batchHash || 'batch'}-${index}`),
  }));
  function historySummary(entry: CompletedBatch | null | undefined): Array<{ label: string; count: number }> {
    const operations = entry?.operations;
    if (operations && typeof operations === 'object') {
      return [
        { label: 'Flashloan', count: Number(operations.flashloans || 0) },
        { label: 'ReserveToCollateral', count: Number(operations.reserveToCollateral || 0) },
        { label: 'CollateralToReserve', count: Number(operations.collateralToReserve || 0) },
        { label: 'Settlement', count: Number(operations.settlements || 0) },
        { label: 'ReserveToReserve', count: Number(operations.reserveToReserve || 0) },
        { label: 'DisputeStart', count: Number(operations.disputeStarts || 0) },
        { label: 'DisputeFinalize', count: Number(operations.disputeFinalizations || 0) },
        { label: 'ExternalTokenToReserve', count: Number(operations.externalTokenToReserve || 0) },
        { label: 'ReserveToExternalToken', count: Number(operations.reserveToExternalToken || 0) },
        { label: 'RevealSecret', count: Number(operations.revealSecrets || 0) },
      ].filter((entry) => entry.count > 0);
    }
    const opCount = Number(entry?.opCount || 0);
    return opCount > 0 ? [{ label: 'Ops', count: opCount }] : [];
  }

  function historyOriginLabel(entry: CompletedBatch | null | undefined): string {
    if (entry?.source === 'counterparty-event') return 'Counterparty Event';
    return 'Self Batch';
  }

  $: selectedAccount = counterpartyEntityId ? currentReplica?.state?.accounts?.get?.(counterpartyEntityId) : null;
  $: selectedAccountActiveDispute = selectedAccount?.activeDispute ?? null;
  $: selectedAccountStatus = String(selectedAccount?.status || '');
  $: selectedDisputeTimeout = Number(selectedAccountActiveDispute?.disputeTimeout || 0);
  $: selectedDisputeBlocksLeft = selectedAccountActiveDispute
    ? Math.max(0, selectedDisputeTimeout - Math.max(Number(currentReplica?.state?.lastFinalizedJHeight || 0), Number(liveJHeight || 0)))
    : 0;

  function getReserveBalance(currentTokenId: number): bigint {
    return currentReplica?.state?.onchainReserves?.get?.(currentTokenId) ?? 0n;
  }

  function getActionMaxAmount(): bigint {
    return action === 'transfer' ? getReserveBalance(tokenId) : 0n;
  }

  function fillActionMax(): void {
    const amountBig = getActionMaxAmount();
    amount = formatTokenInputAmount(amountBig, getTokenDecimals(tokenId));
  }

  $: actionMaxAmount = getActionMaxAmount();

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
      const entityTxs: EntityTx[] = [{
        type: 'j_broadcast',
        data: feeOverrides ? { feeOverrides } : {},
      }];
      await enqueueEntityInputs(env, [{
        entityId,
        signerId,
        entityTxs,
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

      const recipient = recipientEntityId || counterpartyEntityId;
      if (!recipient) throw new Error('Select a recipient');
      if (recipient.toLowerCase() === entityId.toLowerCase()) throw new Error('Cannot transfer to yourself');
      const entityTx: PendingSettleEntityTx = {
        type: 'reserve_to_reserve' as const,
        data: {
          toEntityId: recipient,
          tokenId,
          amount: parsedAmount,
        },
      };

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
      <div class="batch-status-meta">History ({batchHistory.length})</div>
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
                      avatarUrl: entityAvatar(String(opEntityId || '')),
                    }}
                    <div class="entity-chip" title={identity.id}>
                      {#if identity.avatarUrl}
                        <img class="entity-chip-avatar" src={identity.avatarUrl} alt="" />
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
        {#if sending}
          Signing & Broadcasting...
        {:else}
          Sign & Broadcast
        {/if}
      </button>
    </div>
    {#if hasSentBatch && hasDraftBatch}
      <p class="batch-empty">Draft queued. Broadcast unlocks automatically once sent batch finalizes.</p>
    {/if}

  </div>

    <div class="action-tabs">
    <button class="tab" class:active={action === 'transfer'} on:click={() => action = 'transfer'} disabled={sending}>Reserve → Reserve</button>
    <button class="tab" class:active={action === 'dispute'} on:click={() => action = 'dispute'} disabled={sending}>Dispute</button>
    <button class="tab" class:active={action === 'history'} on:click={() => action = 'history'} disabled={sending}>History ({batchHistory.length})</button>
  </div>

  <p class="action-desc">
    {#if action === 'dispute'}
      Queue dispute start/finalize for selected account.
    {:else if action === 'history'}
      Review {batchHistory.length} finalized on-chain batch{batchHistory.length === 1 ? '' : 'es'} for this entity.
    {:else}
      Queue reserve-to-reserve transfer to another entity.
    {/if}
  </p>

  {#if action === 'history'}
    <div class="history-card">
      <div class="history-header">
        <div class="history-title">On-Chain Batch History</div>
        <div class="history-subtitle">{batchHistory.length} finalized batch{batchHistory.length === 1 ? '' : 'es'}</div>
      </div>

      {#if batchHistory.length === 0}
        <div class="batch-empty">No finalized batches yet.</div>
      {:else}
        <div class="history-list">
          {#each batchHistoryRows as row, index (row.key)}
            {@const entry = row.entry}
            <details class="history-item" data-testid="settle-history-item" open={index === 0}>
              <summary>
                <span class="history-status {entry.status === 'failed' ? 'failed' : 'confirmed'}">
                  {entry.status === 'failed' ? 'Failed' : 'Confirmed'}
                </span>
                <span class="history-origin {entry.source === 'counterparty-event' ? 'counterparty' : ''}">
                  {historyOriginLabel(entry)}
                </span>
                <span>Nonce #{Number(entry.entityNonce || 0)}</span>
                <span>J#{Number(entry.jBlockNumber || 0)}</span>
                <span>{Number(entry.opCount || 0)} ops</span>
                {#if entry.txHash}
                  <code>{String(entry.txHash || '').slice(0, 12)}...</code>
                {/if}
              </summary>
              <div class="history-body">
                <div class="history-meta">
                  <span>Broadcast: {formatDateTime(Number(entry.broadcastedAt || 0))}</span>
                  <span>Finalized: {formatDateTime(Number(entry.confirmedAt || 0))}</span>
                  <span>Batch: {String(entry.batchHash || '').slice(0, 16)}...</span>
                  {#if entry.eventType}
                    <span>Event: {entry.eventType}</span>
                  {/if}
                </div>
                {#if entry.note}
                  <div class="history-note">{entry.note}</div>
                {/if}
                {#if row.details.length > 0}
                  <div class="batch-ops-grid history-ops-grid">
                    {#each row.details as op (op.key)}
                      <article class="batch-op-card history-op-card">
                        <div class="batch-op-title">{op.operation}</div>
                        {#if op.entities.length > 0}
                          <div class="batch-op-entities">
                            {#each op.entities as opEntityId}
                              {@const identity = {
                                id: String(opEntityId || ''),
                                short: formatShortId(String(opEntityId || '')),
                                name: entityName(String(opEntityId || '')),
                                avatarUrl: entityAvatar(String(opEntityId || '')),
                              }}
                              <div class="entity-chip" title={identity.id}>
                                {#if identity.avatarUrl}
                                  <img class="entity-chip-avatar" src={identity.avatarUrl} alt="" />
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
                {:else if historySummary(entry).length > 0}
                  <div class="batch-summary">
                    {#each historySummary(entry) as item}
                      <span class="summary-chip">{item.label}: {item.count}</span>
                    {/each}
                  </div>
                {/if}
              </div>
            </details>
          {/each}
        </div>
      {/if}
    </div>
  {:else if action === 'dispute'}
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
  {/if}

  {#if action === 'transfer'}
    <label class="settle-field settle-field-wide">
      <span>Amount</span>
      <div class="settle-amount-shell">
        <input type="text" bind:value={amount} placeholder="0.00" disabled={sending} />
        <div class="settle-inline-controls">
          <button
            type="button"
            class="settle-max-link"
            on:click={fillActionMax}
            disabled={sending || actionMaxAmount <= 0n}
          >
            {formatInlineMaxHint(actionMaxAmount, tokenId)}
          </button>
          <div class="settle-token-inline">
            <TokenSelect value={tokenId} compact={true} disabled={sending} on:change={handleTokenChange} />
          </div>
        </div>
      </div>
    </label>

    <button
      data-testid="settle-queue-action"
      class="btn-submit"
      on:click={submitAction}
      disabled={sending || !amount || !recipientEntityId || isSelfTransfer}
    >
      {#if sending}
        Processing...
      {:else}
        Queue Reserve → Reserve
      {/if}
    </button>
  {/if}

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

  .history-ops-grid {
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  }

  .history-op-card {
    background: #111111;
    border-color: #2e2e2e;
  }

  .preview-label {
    font-size: 10px;
    font-weight: 700;
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.05em;
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

  .history-card {
    margin-top: 12px;
    border: 1px solid #292524;
    border-radius: 10px;
    background: #151310;
    padding: 10px;
  }

  .history-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
  }

  .history-title {
    font-size: 12px;
    font-weight: 700;
    color: #f3f4f6;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .history-subtitle {
    font-size: 11px;
    color: #9ca3af;
  }

  .history-list {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .history-item {
    border: 1px solid #292524;
    border-radius: 8px;
    background: #0c0a09;
    overflow: hidden;
  }

  .history-item summary {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    cursor: pointer;
    padding: 8px 10px;
    font-size: 11px;
    color: #d6d3d1;
    font-family: 'JetBrains Mono', monospace;
  }

  .history-item summary::-webkit-details-marker {
    display: none;
  }

  .history-status {
    border-radius: 999px;
    border: 1px solid rgba(74, 222, 128, 0.45);
    color: #86efac;
    background: rgba(20, 83, 45, 0.22);
    padding: 2px 8px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .history-status.failed {
    border-color: rgba(248, 113, 113, 0.45);
    color: #fecaca;
    background: rgba(127, 29, 29, 0.24);
  }

  .history-origin {
    border-radius: 999px;
    border: 1px solid rgba(234, 179, 8, 0.35);
    color: #fde68a;
    background: rgba(120, 53, 15, 0.2);
    padding: 2px 8px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .history-origin.counterparty {
    border-color: rgba(248, 113, 113, 0.45);
    color: #fecaca;
    background: rgba(127, 29, 29, 0.24);
  }

  .history-body {
    border-top: 1px solid #292524;
    padding: 8px 10px 10px;
  }

  .history-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 11px;
    color: #a8a29e;
    font-family: 'JetBrains Mono', monospace;
  }

  .history-note {
    margin-top: 8px;
    font-size: 12px;
    color: #fca5a5;
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
    flex-wrap: wrap;
    gap: 6px;
    background: #0c0a09;
    border-radius: 8px;
    padding: 4px;
  }

  .tab {
    flex: 1 1 160px;
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

  .settle-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .settle-field-wide {
    width: 100%;
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

  .settle-amount-shell {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 48px;
    padding: 0 8px 0 12px;
    background: #110d0b;
    border: 1px solid #322821;
    border-radius: 12px;
  }

  .settle-amount-shell:focus-within {
    border-color: #fbbf24;
    box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.12);
  }

  .settle-amount-shell input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 0;
    color: #f5f5f4;
    font-size: 15px;
  }

  .settle-inline-controls {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    flex: 0 0 auto;
    min-width: 0;
    padding-left: 8px;
  }

  .settle-max-link {
    border: none;
    background: transparent;
    padding: 0;
    color: #8d857d;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    max-width: 72px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .settle-max-link:hover:not(:disabled) {
    color: #f5f5f4;
  }

  .settle-max-link:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .settle-token-inline {
    flex: 0 0 auto;
    min-width: 94px;
  }

  .settle-token-inline :global(.token-select.compact .select-trigger) {
    min-height: 32px;
    padding: 0 18px 0 2px;
    border-radius: 0;
    background: transparent;
    border: none;
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

  @media (max-width: 900px) {
    .gas-presets {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .gas-custom-row {
      grid-template-columns: 1fr;
    }

    .settle-amount-shell {
      flex-direction: column;
      align-items: stretch;
      padding: 12px;
    }

    .settle-inline-controls {
      width: 100%;
      justify-content: space-between;
    }

    .settle-token-inline {
      min-width: 0;
    }

    .batch-actions {
      flex-direction: column;
    }
  }
</style>
