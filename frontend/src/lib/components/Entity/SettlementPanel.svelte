<script lang="ts">
  import { getXLN, submitEntityInputs, xlnFunctions } from '../../stores/xlnStore';
  import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
  import type { EntityReplica, EntityTx, AccountState, EntityState } from '$lib/types/ui';
  import type { RuntimeState, EnvSnapshot, Profile as GossipProfile } from '@xln/runtime/xln-api';
  import { errorLog } from '../../stores/errorLogStore';
  import { toasts } from '../../stores/toastStore';
  import { entityAvatar as resolveEntityAvatar } from '$lib/utils/avatar';
  import EntityInput from '../shared/EntityInput.svelte';
  import TokenSelect from '../shared/TokenSelect.svelte';
  import ActivityHistoryPanel from './ActivityHistoryPanel.svelte';
  import { requireTokenDecimals } from './token-metadata';

  export let entityId: string;
  export let replica: EntityReplica | null = null;
  export let historyOnly = false;
  export let env: RuntimeState | EnvSnapshot | null = null;
  export let isLive: boolean;
  export let profiles: GossipProfile[] = [];
  type Action = 'r2c' | 'c2r' | 'transfer' | 'history';
  type GasPreset = 'standard' | 'fast' | 'urgent' | 'custom';
  type BatchDetailField = { label: string; value: string };
  type BatchDetailOp = {
    key: string;
    operation: string;
    entities: string[];
    details: BatchDetailField[];
  };
  type RuntimeEnv = RuntimeState;
  type JBatchState = NonNullable<EntityState['jBatchState']>;
  type BatchShape = JBatchState['batch'];
  type ActiveDispute = NonNullable<AccountState['activeDispute']>;
  type FeeOverrides = { gasBumpBps?: number; maxFeePerGasWei?: string; maxPriorityFeePerGasWei?: string };
  type PendingSettleEntityTx = Extract<EntityTx, { type: 'r2r' }>;
  type SettlementLike = {
    leftEntity?: unknown;
    rightEntity?: unknown;
    diffs?: Array<{ leftDiff?: unknown; rightDiff?: unknown }>;
  };

  $: activeXlnFunctions = $xlnFunctions;
  $: activeEnv = env;
  $: activeIsLive = isLive;
  // Settlement must read the same visible entity replica as the rest of the screen.
  // Mixing a second live lookup here causes split-brain UI (Assets sees new reserves, Settle sees old zeroes).
  $: currentReplica = replica ?? null;

  let counterpartyEntityId = '';
  let recipientEntityId = '';
  let tokenId = 1;
  let action: Action = 'r2c';
  let amount = '';
  let sending = false;

  $: if (historyOnly && action !== 'history') {
    action = 'history';
  }

  let gasPreset: GasPreset = 'standard';
  let customMaxFeeGwei = '';
  let customPriorityFeeGwei = '';
  let autoExecuteWorkspaceKey = '';
  let autoExecutingWorkspaceKey = '';

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
    if (!activeXlnFunctions) throw new Error(`TOKEN_METADATA_READER_UNAVAILABLE:token:${token}`);
    const tokenInfo = activeXlnFunctions.getTokenInfo(token);
    const decimals = requireTokenDecimals(tokenInfo.decimals, `token:${token}`);
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
    if (!activeXlnFunctions) throw new Error(`TOKEN_METADATA_READER_UNAVAILABLE:token:${currentTokenId}`);
    return requireTokenDecimals(
      activeXlnFunctions.getTokenInfo(currentTokenId).decimals,
      `token:${currentTokenId}`,
    );
  }

  function formatInlineMaxHint(amountBig: bigint, currentTokenId: number): string {
    if (amountBig <= 0n) return '0';
    return formatTokenInputAmount(amountBig, getTokenDecimals(currentTokenId));
  }

  function formatConfirmAmount(currentTokenId: number, amountBig: bigint): string {
    if (activeXlnFunctions?.formatTokenAmount) {
      return activeXlnFunctions.formatTokenAmount(currentTokenId, amountBig);
    }
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

    for (const [index, op] of (Array.isArray(batch.flashloans) ? batch.flashloans : []).entries()) {
      pushOp(
        'increase',
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
            { label: 'Incremented Args', value: shortHex(op?.starterIncrementedArguments) },
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

    return [...reserveIncreaseOps, ...reserveDecreaseOps, ...neutralOps];
  }

  function formatWeiToGwei(wei: bigint): string {
    const base = 1_000_000_000n;
    const whole = wei / base;
    const frac2 = ((wei % base) * 100n) / base;
    return `${whole.toString()}.${frac2.toString().padStart(2, '0')}`;
  }

  function buildFeeOverrides(): { gasBumpBps?: number; maxFeePerGasWei?: string; maxPriorityFeePerGasWei?: string } | null {
    if (gasPreset !== 'custom') return null;
    const out: { maxFeePerGasWei?: string; maxPriorityFeePerGasWei?: string } = {};
    if (customMaxFeeGwei.trim()) {
      out.maxFeePerGasWei = parseDecimalToUnits(customMaxFeeGwei, 9).toString();
    }
    if (customPriorityFeeGwei.trim()) {
      out.maxPriorityFeePerGasWei = parseDecimalToUnits(customPriorityFeeGwei, 9).toString();
    }
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
    for (const profile of profiles) add(profile.entityId);

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
      { label: 'ExternalTokenToReserve', count: Number(batch?.externalTokenToReserve?.length || 0) },
      { label: 'CollateralToReserve', count: Number(batch?.collateralToReserve?.length || 0) },
      { label: 'Settlement', count: Number(batch?.settlements?.length || 0) },
      { label: 'ReserveToReserve', count: Number(batch?.reserveToReserve?.length || 0) },
      { label: 'ReserveToCollateral', count: Number(batch?.reserveToCollateral?.length || 0) },
      { label: 'ReserveToExternalToken', count: Number(batch?.reserveToExternalToken?.length || 0) },
      { label: 'DisputeStart', count: Number(batch?.disputeStarts?.length || 0) },
      { label: 'DisputeFinalize', count: Number(batch?.disputeFinalizations?.length || 0) },
      { label: 'RevealSecret', count: Number(batch?.revealSecrets?.length || 0) },
    ].filter((entry) => entry.count > 0);
  }

  $: jBatchState = currentReplica?.state?.jBatchState ?? null;
  $: jBatch = jBatchState?.batch || null;
  $: sentBatch = jBatchState?.sentBatch || null;
  $: pendingOps = countBatchOps(jBatch);
  $: sentOps = countBatchOps(sentBatch?.batch);
  $: hasSentBatch = !!sentBatch;
  $: hasDraftBatch = pendingOps > 0;
  $: hasAnyBatch = hasSentBatch || hasDraftBatch;
  $: canBroadcastDraft = !hasSentBatch && hasDraftBatch;
  $: pendingSummary = batchSummary(jBatch);
  $: draftDetailOps = buildBatchDetailOps(jBatch);
  $: selectedAccount = counterpartyEntityId ? currentReplica?.state?.accounts?.get?.(counterpartyEntityId) : null;
  $: selectedSettlementTransition = [
    ...(selectedAccount?.mempool ?? []),
    ...(selectedAccount?.pendingFrame?.accountTxs ?? []),
  ].find((tx) => tx.type === 'settle_transition');
  $: selectedAccountActiveDispute = selectedAccount?.activeDispute ?? null;
  $: selectedAccountStatus = String(selectedAccount?.status || '');
  $: selectedDisputeTimeout = Number(selectedAccountActiveDispute?.disputeTimeout || 0);
  $: selectedDisputeBlocksLeft = selectedAccountActiveDispute
    ? Math.max(
        0,
        selectedDisputeTimeout - Math.max(
          Number(selectedAccount?.lastFinalizedJHeight || 0),
          Number(currentReplica?.state?.lastFinalizedJHeight || 0),
        ),
      )
    : 0;

  function requireCurrentReplica(): EntityReplica {
    if (!currentReplica) throw new Error('Current entity replica is not available');
    return currentReplica;
  }

  function getReserveBalance(currentTokenId: number): bigint {
    return requireCurrentReplica().state.reserves.get(currentTokenId) ?? 0n;
  }

  function getWorkspaceDerivedDelta(currentTokenId: number) {
    const account = selectedAccount;
    const owner = String(entityId || '').trim().toLowerCase();
    const counterparty = String(counterpartyEntityId || '').trim().toLowerCase();
    if (!account || !owner || !counterparty || !activeXlnFunctions?.deriveDelta) return null;
    const delta = account.deltas?.get?.(currentTokenId);
    if (!delta) return null;
    return activeXlnFunctions.deriveDelta(delta, owner < counterparty);
  }

  function getWorkspaceWithdrawableCollateral(currentTokenId: number): bigint {
    const derived = getWorkspaceDerivedDelta(currentTokenId);
    if (!derived) return 0n;
    const hold = derived.outTotalHold ?? 0n;
    return derived.outCollateral > hold ? derived.outCollateral - hold : 0n;
  }

  function isLocalExecutorForWorkspace(counterparty: string, account: AccountState | null): boolean {
    const workspace = account?.settlementWorkspace;
    const owner = String(entityId || '').trim().toLowerCase();
    const peer = String(counterparty || '').trim().toLowerCase();
    if (!workspace || workspace.status !== 'ready_to_submit' || !owner || !peer) return false;
    return workspace.executorIsLeft === (owner < peer);
  }

  function getWorkspaceAutoExecuteKey(counterparty: string, account: AccountState | null): string {
    const workspace = account?.settlementWorkspace;
    if (!workspace) return '';
    const nonceAtSign = workspace.nonceAtSign ?? 0;
    return `${normalizeEntityId(counterparty)}:${workspace.revision}:${workspace.status}:${nonceAtSign}`;
  }

  function toErrorMessage(err: unknown, fallback = 'Unknown error'): string {
    return err instanceof Error && err.message ? err.message : fallback;
  }

  function logSettlementDiagnostic(message: string, err: unknown): void {
    errorLog.log(message, 'Settlement Panel', {
      entityId,
      counterpartyEntityId,
      recipientEntityId,
      tokenId,
      action,
      err,
    });
  }

  function notifySettlementError(message: string, err: unknown, toastPrefix: string): void {
    logSettlementDiagnostic(message, err);
    toasts.error(`${toastPrefix}: ${toErrorMessage(err)}`);
  }

  function getActionMaxAmount(): bigint {
    if (action === 'transfer' || action === 'r2c') return getReserveBalance(tokenId);
    if (action === 'c2r') return getWorkspaceWithdrawableCollateral(tokenId);
    return 0n;
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

      await submitEntityInputs([{
        entityId,
        signerId,
        entityTxs: [{ type: 'j_clear_batch', data: { reason: 'manual-clear-from-ui' } }],
      }]);
    } catch (err) {
      notifySettlementError('Settlement batch clear failed', err, 'Clear failed');
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
      await submitEntityInputs([{
        entityId,
        signerId,
        entityTxs,
      }]);
    } catch (error) {
      notifySettlementError('On-J batch broadcast failed', error, 'Batch failed');
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
      await submitEntityInputs([{
        entityId,
        signerId,
        entityTxs: [{ type: 'j_rebroadcast', data: { gasBumpBps } }],
      }]);
    } catch (error) {
      notifySettlementError('On-J batch rebroadcast failed', error, 'Rebroadcast failed');
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
        type: 'r2r' as const,
        data: {
          toEntityId: recipient,
          tokenId,
          amount: parsedAmount,
        },
      };

      await submitEntityInputs([{
        entityId,
        signerId,
        entityTxs: [entityTx],
      }]);
      amount = '';
    } catch (error) {
      notifySettlementError('On-J transfer action failed', error, 'Failed');
    } finally {
      sending = false;
    }
  }

  async function queueReserveToCollateral(): Promise<void> {
    if (!counterpartyEntityId) throw new Error('Select account first');
    const parsedAmount = parsePositiveAmount(amount, tokenId);
    const reserveBalance = getReserveBalance(tokenId);
    if (parsedAmount > reserveBalance) {
      const requestedLabel = formatConfirmAmount(tokenId, parsedAmount);
      const reserveLabel = formatConfirmAmount(tokenId, reserveBalance);
      const proceed = confirm(
        `Requested Reserve → Collateral exceeds current reserve.\n\n` +
        `Current reserve: ${reserveLabel}\n` +
        `Requested amount: ${requestedLabel}\n\n` +
        `Queue it anyway?`,
      );
      if (!proceed) return;
    }
    const env = activeEnv;
    if (!env || !isRuntimeEnv(env)) throw new Error('Runtime environment not available');
    if (!activeIsLive) throw new Error('On-chain actions are only available in LIVE mode');
    const signerId = resolveSignerId(env);
    await submitEntityInputs([{
      entityId,
      signerId,
      entityTxs: [{
        type: 'r2c',
        data: {
          counterpartyId: counterpartyEntityId,
          tokenId,
          amount: parsedAmount,
        },
      }],
    }]);
    amount = '';
  }

  async function queueCollateralToReserve(): Promise<void> {
    if (!counterpartyEntityId) throw new Error('Select account first');
    const parsedAmount = parsePositiveAmount(amount, tokenId);
    const withdrawable = getWorkspaceWithdrawableCollateral(tokenId);
    if (parsedAmount > withdrawable) throw new Error('Amount exceeds available collateral');
    const env = activeEnv;
    if (!env || !isRuntimeEnv(env)) throw new Error('Runtime environment not available');
    if (!activeIsLive) throw new Error('On-chain actions are only available in LIVE mode');
    const signerId = resolveSignerId(env);
    await submitEntityInputs([{
      entityId,
      signerId,
      entityTxs: [{
        type: 'settle_propose',
        data: {
          counterpartyEntityId,
          executorIsLeft: String(entityId).trim().toLowerCase() < counterpartyEntityId.toLowerCase(),
          memo: 'settle-c2r',
          ops: [{ type: 'c2r', tokenId, amount: parsedAmount }],
        },
      }],
    }]);
    amount = '';
  }

  async function autoAddSignedWorkspaceToDraft(): Promise<void> {
    if (historyOnly) return;
    const account = selectedAccount;
    const counterparty = String(counterpartyEntityId || '').trim();
    if (!counterparty || !account) return;
    if (!isLocalExecutorForWorkspace(counterparty, account)) return;
    const workspaceKey = getWorkspaceAutoExecuteKey(counterparty, account);
    if (!workspaceKey || workspaceKey === autoExecuteWorkspaceKey || workspaceKey === autoExecutingWorkspaceKey) return;

    const env = activeEnv;
    if (!env || !isRuntimeEnv(env)) return;
    if (!activeIsLive) return;

    autoExecutingWorkspaceKey = workspaceKey;
    try {
      const signerId = resolveSignerId(env);
      await submitEntityInputs([{
        entityId,
        signerId,
        entityTxs: [{
          type: 'settle_execute',
          data: {
            counterpartyEntityId: counterparty,
          },
        }],
      }]);
      autoExecuteWorkspaceKey = workspaceKey;
    } catch (error) {
      logSettlementDiagnostic('Settlement auto execute into draft failed', error);
    } finally {
      autoExecutingWorkspaceKey = '';
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
    if (gasPreset !== 'custom') return { maxFeeWei: 0n, maxPriorityWei: 0n };
    let maxFeeWei = 0n;
    let maxPriorityWei = 0n;
    try {
      if (customMaxFeeGwei.trim()) maxFeeWei = parseDecimalToUnits(customMaxFeeGwei, 9);
      if (customPriorityFeeGwei.trim()) maxPriorityWei = parseDecimalToUnits(customPriorityFeeGwei, 9);
    } catch {
      return { maxFeeWei: 0n, maxPriorityWei: 0n };
    }
    return { maxFeeWei, maxPriorityWei };
  })();

  $: {
    if (historyOnly) {
      autoExecutingWorkspaceKey = '';
      autoExecuteWorkspaceKey = '';
    } else if (
      !selectedAccount?.settlementWorkspace
      || selectedAccount.settlementWorkspace.status !== 'ready_to_submit'
    ) {
      autoExecuteWorkspaceKey = '';
    } else {
      const workspaceKey = getWorkspaceAutoExecuteKey(counterpartyEntityId, selectedAccount ?? null);
      if (
        isLocalExecutorForWorkspace(counterpartyEntityId, selectedAccount ?? null)
        && workspaceKey
        && workspaceKey !== autoExecuteWorkspaceKey
        && workspaceKey !== autoExecutingWorkspaceKey
      ) {
        // Once the counterparty has signed, the local executor should immediately
        // materialize the signed settlement into the local draft batch. This is
        // still a local draft step only; j_broadcast remains an explicit user action.
        void autoAddSignedWorkspaceToDraft();
      }
    }
  }

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

    {#if hasAnyBatch}
      <div class="gas-card">
        <div class="gas-header">
          <span>Gas</span>
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

    {#if !historyOnly}
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
    {/if}

  </div>

  {#if !historyOnly}
    <div class="action-tabs">
      <button class="tab" class:active={action === 'r2c'} on:click={() => action = 'r2c'} disabled={sending}>Reserve → Collateral</button>
      <button class="tab" class:active={action === 'c2r'} on:click={() => action = 'c2r'} disabled={sending}>Collateral → Reserve</button>
      <button class="tab" class:active={action === 'transfer'} on:click={() => action = 'transfer'} disabled={sending}>Reserve → Reserve</button>
      <button class="tab" class:active={action === 'history'} on:click={() => action = 'history'} disabled={sending}>History</button>
    </div>

    <p class="action-desc">
      {#if action === 'r2c'}
        Queue reserve-to-collateral into the current draft batch.
      {:else if action === 'c2r'}
        Queue collateral-to-reserve. Once the counterparty signs, it is added to your local draft batch.
      {:else if action === 'history'}
        Review the durable Entity activity stream with on-chain and off-chain filters.
      {:else}
        Queue reserve-to-reserve transfer to another entity.
      {/if}
    </p>
  {/if}

  {#if action === 'history'}
    <ActivityHistoryPanel {entityId} runtimeId={activeEnv?.runtimeId} />
  {:else if action === 'r2c' || action === 'c2r'}
    <EntityInput
      label="Account"
      value={counterpartyEntityId}
      entities={accountEntityIds}
      {profiles}
      excludeId={entityId}
      disabled={sending}
      on:change={handleAccountChange}
    />

    <label class="settle-field settle-field-wide">
      <span>Amount</span>
      <div class="settle-amount-shell">
        <input type="text" bind:value={amount} data-testid="settlement-amount-input" aria-label="Settlement amount" disabled={sending} />
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

    {#if action === 'c2r' && selectedSettlementTransition}
      <p class="dispute-state">Committing the settlement workspace in bilateral consensus.</p>
    {:else if action === 'c2r' && selectedAccount?.settlementWorkspace?.status === 'awaiting_counterparty'}
      <p class="dispute-state">
        Waiting for counterparty signature.
      </p>
    {:else if action === 'c2r' && autoExecutingWorkspaceKey}
      <p class="dispute-state">Counterparty signed. Adding to local draft batch.</p>
    {/if}

    <button
      data-testid={action === 'r2c' ? 'settle-queue-r2c' : 'settle-queue-c2r'}
      class="btn-submit"
      on:click={action === 'r2c' ? queueReserveToCollateral : queueCollateralToReserve}
      disabled={sending || Boolean(selectedSettlementTransition) || !counterpartyEntityId || !amount}
    >
      {#if sending}
        Processing...
      {:else if action === 'r2c'}
        Queue Reserve → Collateral
      {:else}
        Queue Collateral → Reserve
      {/if}
    </button>
  {:else if action === 'transfer'}
    <EntityInput
      label="Recipient"
      value={recipientEntityId}
      entities={transferEntityOptions}
      {profiles}
      excludeId={entityId}
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
        <input type="text" bind:value={amount} data-testid="settlement-transfer-amount-input" aria-label="Transfer amount" disabled={sending} />
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
      disabled={sending || !amount || !recipientEntityId || Boolean(isSelfTransfer)}
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

  .dispute-state {
    margin: 8px 0 0;
    color: #fda4af;
    font-size: 12px;
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
