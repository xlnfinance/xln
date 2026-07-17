import type { EntityTx, JBatch } from '@xln/runtime/xln-api';
import {
  simulateDraftBatchReserveAvailability,
  type DraftBatchReserveIssue,
} from '@xln/runtime/jurisdiction/batch';
import type { FrontendXlnFunctions } from '$lib/stores/xlnStore';
import type { EntityReplica } from '$lib/types/ui';
import { amountToUsd } from '$lib/utils/assetPricing';
import { getEntityDisplayName } from '$lib/utils/entityNaming';
import { requireTokenDecimals } from './token-metadata';

type GossipSource = Parameters<typeof getEntityDisplayName>[1]['source'];

export type PendingBatchPreviewItem = {
  key: string;
  title: string;
  subtitle: string;
};

export type PendingBatchMode = 'draft' | 'sent' | null;

export type PendingBatchState = {
  draftCount: number;
  sentCount: number;
  count: number;
  mode: PendingBatchMode;
  hasDraftBatch: boolean;
  hasSentBatch: boolean;
  previewBatch: JBatch | null;
};

export type PendingBatchAction = 'clear' | 'broadcast' | 'rebroadcast';

type PendingBatchLabelOptions = {
  activeEnv: GossipSource;
  selfEntityId: string;
  activeXlnFunctions: FrontendXlnFunctions | null;
};

type PendingBatchPreviewOptions = PendingBatchLabelOptions;

type PendingBatchSettlementLike = {
  leftEntity?: unknown;
  rightEntity?: unknown;
  diffs?: Array<{ leftDiff?: unknown; rightDiff?: unknown }>;
};

type OpenDebtTotalsOptions = {
  replica: EntityReplica | null;
  activeXlnFunctions: FrontendXlnFunctions | null;
};

export function countBatchOps(batch: JBatch | null | undefined): number {
  if (!batch) return 0;
  return (batch.reserveToCollateral?.length || 0) +
    (batch.collateralToReserve?.length || 0) +
    (batch.settlements?.length || 0) +
    (batch.reserveToReserve?.length || 0) +
    (batch.disputeStarts?.length || 0) +
    (batch.disputeFinalizations?.length || 0) +
    (batch.externalTokenToReserve?.length || 0) +
    (batch.reserveToExternalToken?.length || 0) +
    (batch.revealSecrets?.length || 0);
}

export function buildPendingBatchState(jBatchState: {
  batch?: JBatch | null;
  sentBatch?: { batch?: JBatch | null } | null;
} | null | undefined): PendingBatchState {
  const draftBatch = jBatchState?.batch || null;
  const sentBatch = jBatchState?.sentBatch?.batch || null;
  const draftCount = countBatchOps(draftBatch);
  const sentCount = countBatchOps(sentBatch);
  const mode: PendingBatchMode = draftCount > 0 ? 'draft' : sentCount > 0 ? 'sent' : null;
  return {
    draftCount,
    sentCount,
    count: draftCount > 0 ? draftCount : sentCount,
    mode,
    hasDraftBatch: draftCount > 0,
    hasSentBatch: sentCount > 0,
    previewBatch: mode === 'draft' ? draftBatch : mode === 'sent' ? sentBatch : null,
  };
}

export function canBroadcastPendingBatch(state: Pick<PendingBatchState, 'hasDraftBatch' | 'hasSentBatch'>, reserveIssue: unknown): boolean {
  return state.hasDraftBatch && !state.hasSentBatch && !reserveIssue;
}

export function buildPendingBatchActionTxs(action: PendingBatchAction): EntityTx[] {
  if (action === 'clear') {
    return [{
      type: 'j_clear_batch',
      data: { reason: 'global-batch-bar-clear' },
    }];
  }
  if (action === 'broadcast') {
    return [{
      type: 'j_broadcast',
      data: {},
    }];
  }
  return [{
    type: 'j_rebroadcast',
    data: { gasBumpBps: 1000 },
  }];
}

export function pendingBatchEntityLabel(entityId: string, options: PendingBatchLabelOptions): string {
  const raw = String(entityId || '').trim();
  return getEntityDisplayName(raw, {
    source: options.activeEnv,
    selfEntityId: options.selfEntityId,
    fallback: 'Unknown',
  });
}

function pendingBatchTokenAmountLabel(
  tokenIdRaw: unknown,
  amountRaw: unknown,
  options: PendingBatchLabelOptions,
): string {
  const tokenId = Number(tokenIdRaw || 0);
  const amount = typeof amountRaw === 'bigint'
    ? amountRaw
    : (() => {
        try {
          return BigInt(String(amountRaw ?? 0));
        } catch {
          return 0n;
        }
      })();
  if (tokenId > 0 && options.activeXlnFunctions?.formatTokenAmount) {
    return options.activeXlnFunctions.formatTokenAmount(tokenId, amount);
  }
  return `${amount.toString()} ${tokenId > 0 ? `Token #${tokenId}` : 'token'}`;
}

function pendingBatchShortHex(value: unknown): string {
  const text = String(value || '');
  if (!text) return '—';
  if (text.length <= 18) return text;
  return `${text.slice(0, 10)}...${text.slice(-6)}`;
}

function pendingBatchToBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.trim()) {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function pendingBatchIsSelfEntity(value: unknown, selfEntityId: string): boolean {
  const self = String(selfEntityId || '').trim().toLowerCase();
  const candidate = String(value || '').trim().toLowerCase();
  return !!self && !!candidate && self === candidate;
}

function pendingBatchSettlementReserveDelta(
  settlement: PendingBatchSettlementLike | null | undefined,
  selfEntityId: string,
): bigint {
  const leftIsSelf = pendingBatchIsSelfEntity(settlement?.leftEntity, selfEntityId);
  const rightIsSelf = pendingBatchIsSelfEntity(settlement?.rightEntity, selfEntityId);
  if (!leftIsSelf && !rightIsSelf) return 0n;

  let delta = 0n;
  for (const diff of Array.isArray(settlement?.diffs) ? settlement.diffs : []) {
    if (leftIsSelf) {
      delta += pendingBatchToBigInt(diff?.leftDiff);
    } else if (rightIsSelf) {
      delta += pendingBatchToBigInt(diff?.rightDiff);
    }
  }
  return delta;
}

export function buildPendingBatchPreview(
  batch: JBatch | null | undefined,
  options: PendingBatchPreviewOptions,
): PendingBatchPreviewItem[] {
  if (!batch) return [];
  const reserveIncreaseItems: PendingBatchPreviewItem[] = [];
  const reserveDecreaseItems: PendingBatchPreviewItem[] = [];
  const neutralItems: PendingBatchPreviewItem[] = [];
  const pushItem = (phase: 'increase' | 'decrease' | 'neutral', item: PendingBatchPreviewItem): void => {
    if (phase === 'increase') reserveIncreaseItems.push(item);
    else if (phase === 'decrease') reserveDecreaseItems.push(item);
    else neutralItems.push(item);
  };

  for (const [index, op] of (batch.flashloans || []).entries()) {
    pushItem('increase', {
      key: `flash-${index}`,
      title: 'Flashloan',
      subtitle: `${pendingBatchTokenAmountLabel(op.tokenId, op.amount, options)} temporary reserve liquidity`,
    });
  }

  for (const [index, op] of (batch.externalTokenToReserve || []).entries()) {
    pushItem('increase', {
      key: `e2r-${index}`,
      title: 'External → Reserve',
      subtitle: `${pendingBatchTokenAmountLabel(op.internalTokenId, op.amount, options)} to ${pendingBatchEntityLabel(String(op.entity || options.selfEntityId), options)}`,
    });
  }

  for (const [index, op] of (batch.reserveToReserve || []).entries()) {
    const isIncrease = pendingBatchIsSelfEntity(op.receivingEntity, options.selfEntityId);
    pushItem(isIncrease ? 'increase' : 'decrease', {
      key: `r2r-${index}`,
      title: isIncrease ? 'Reserve ← Reserve' : 'Reserve → Reserve',
      subtitle: `${pendingBatchTokenAmountLabel(op.tokenId, op.amount, options)} to ${pendingBatchEntityLabel(String(op.receivingEntity || ''), options)}`,
    });
  }

  for (const [index, op] of (batch.collateralToReserve || []).entries()) {
    pushItem('increase', {
      key: `c2r-${index}`,
      title: 'Account → Reserve',
      subtitle: `${pendingBatchTokenAmountLabel(op.tokenId, op.amount, options)} from ${pendingBatchEntityLabel(String(op.counterparty || ''), options)}`,
    });
  }

  for (const [index, op] of (batch.settlements || []).entries()) {
    const reserveDelta = pendingBatchSettlementReserveDelta(op, options.selfEntityId);
    const phase = reserveDelta > 0n ? 'increase' : reserveDelta < 0n ? 'decrease' : 'neutral';
    const reserveLabel = reserveDelta > 0n ? 'Settlement (+Reserve)' : reserveDelta < 0n ? 'Settlement (-Reserve)' : 'Settlement';
    pushItem(phase, {
      key: `settle-${index}`,
      title: reserveLabel,
      subtitle: `${pendingBatchEntityLabel(String(op.leftEntity || ''), options)} ↔ ${pendingBatchEntityLabel(String(op.rightEntity || ''), options)}`,
    });
  }

  for (const [index, op] of (batch.reserveToCollateral || []).entries()) {
    for (const [pairIndex, pair] of (op.pairs || []).entries()) {
      pushItem('decrease', {
        key: `r2c-${index}-${pairIndex}`,
        title: 'Reserve → Account',
        subtitle: `${pendingBatchTokenAmountLabel(op.tokenId, pair.amount, options)} to ${pendingBatchEntityLabel(String(op.receivingEntity || ''), options)} via ${pendingBatchEntityLabel(String(pair.entity || ''), options)}`,
      });
    }
  }

  for (const [index, op] of (batch.reserveToExternalToken || []).entries()) {
    pushItem('decrease', {
      key: `r2e-${index}`,
      title: 'Reserve → External',
      subtitle: `${pendingBatchTokenAmountLabel(op.tokenId, op.amount, options)} to ${pendingBatchEntityLabel(String(op.receivingEntity || options.selfEntityId), options)}`,
    });
  }

  for (const [index, op] of (batch.disputeStarts || []).entries()) {
    pushItem('neutral', {
      key: `dstart-${index}`,
      title: 'Dispute Start',
      subtitle: `Lock account with ${pendingBatchEntityLabel(String(op.counterentity || ''), options)}`,
    });
  }

  for (const [index, op] of (batch.disputeFinalizations || []).entries()) {
    pushItem('neutral', {
      key: `dfinal-${index}`,
      title: 'Dispute Finalize',
      subtitle: `Finalize against ${pendingBatchEntityLabel(String(op.counterentity || ''), options)}`,
    });
  }

  for (const [index, op] of (batch.revealSecrets || []).entries()) {
    pushItem('neutral', {
      key: `secret-${index}`,
      title: 'Reveal Secret',
      subtitle: pendingBatchShortHex(op.secret),
    });
  }

  return [...reserveIncreaseItems, ...reserveDecreaseItems, ...neutralItems];
}

export function buildOpenOutgoingDebtTotals(options: OpenDebtTotalsOptions): {
  count: number;
  usdTotal: number;
  byToken: Map<number, bigint>;
} {
  const byToken = new Map<number, bigint>();
  let count = 0;
  let usdTotal = 0;
  for (const [tokenId, bucket] of options.replica?.state?.outDebtsByToken?.entries?.() || []) {
    let tokenTotal = 0n;
    for (const debt of bucket.values()) {
      if (debt.status !== 'open') continue;
      count += 1;
      tokenTotal += BigInt(debt.remainingAmount || 0);
      const tokenInfo = options.activeXlnFunctions?.getTokenInfo?.(tokenId);
      if (!tokenInfo) throw new Error(`TOKEN_METADATA_READER_UNAVAILABLE:token:${tokenId}`);
      usdTotal += amountToUsd(
        BigInt(debt.remainingAmount || 0),
        requireTokenDecimals(tokenInfo.decimals, `token:${tokenId}`),
        String(tokenInfo.symbol),
      );
    }
    if (tokenTotal > 0n) byToken.set(tokenId, tokenTotal);
  }
  return { count, usdTotal, byToken };
}

export function formatBatchReserveIssue(
  issue: DraftBatchReserveIssue | null,
  options: PendingBatchLabelOptions,
): string | null {
  if (!issue) return null;
  const tokenLabel = pendingBatchTokenAmountLabel(issue.tokenId, issue.requiredAmount, options).replace(/^[\d.,\s]+/, '').trim();
  const spendable = pendingBatchTokenAmountLabel(issue.tokenId, issue.availableAfterDebt, options);
  const debtClaim = pendingBatchTokenAmountLabel(issue.tokenId, issue.debtClaimPaid, options);
  if (issue.opType === 'reserveToExternalToken') {
    return `Reserve withdrawal will fail: debt sweep consumes ${debtClaim} first, leaving only ${spendable} spendable.`;
  }
  if (issue.opType === 'reserveToCollateral') {
    return `Reserve → Account will fail for ${tokenLabel}: debt sweep consumes ${debtClaim} first, leaving only ${spendable}.`;
  }
  return `Reserve → Reserve will fail for ${tokenLabel}: debt sweep consumes ${debtClaim} first, leaving only ${spendable}.`;
}

export function getPendingBatchReserveIssue(options: {
  entityId: string;
  batch: JBatch | null | undefined;
  onchainReserves: Map<number, bigint>;
  openDebtByToken: Map<number, bigint>;
}): DraftBatchReserveIssue | null {
  const entityId = String(options.entityId || '').trim().toLowerCase();
  if (!entityId || !options.batch) return null;
  const simulation = simulateDraftBatchReserveAvailability(
    entityId,
    options.onchainReserves,
    options.batch,
    options.openDebtByToken,
  );
  return simulation.issues[0] ?? null;
}
