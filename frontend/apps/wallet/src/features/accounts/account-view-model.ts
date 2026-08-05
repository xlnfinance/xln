import type {
  Delta,
  DerivedDelta,
  RuntimeAdapterViewFrame,
} from '@xln/runtime/api/public/runtime-module';
import { getJurisdictionStackId } from '@xln/runtime/api/public/runtime-module';

import { formatTokenAmount } from '$lib/components/Entity/entity-asset-values';
import { getCrossJTargetDisputeRiskForProjection } from '$lib/components/Entity/account-dispute-view';
import {
  buildOpenOutgoingDebtByToken,
  buildPendingBatchState,
  canBroadcastPendingBatch,
  getPendingBatchReserveIssue,
} from '$lib/components/Entity/pending-batch-preview';

export type WalletTokenMeta = Readonly<{
  symbol: string;
  decimals: number;
}>;

export type WalletBalanceView = Readonly<{
  tokenId: number;
  symbol: string;
  decimals: number;
  raw: string;
  formatted: string;
}>;

export type WalletTokenCatalogView = Readonly<{
  tokenId: number;
  symbol: string;
  decimals: number;
}>;

export type WalletAccountTokenView = WalletBalanceView & Readonly<{
  outboundRaw: string;
  inboundRaw: string;
  collateralRaw: string;
  ownCreditLimitRaw: string;
  peerCreditLimitRaw: string;
  withdrawableCollateralRaw: string;
  requestedRebalanceRaw: string;
  uncollateralizedRaw: string;
  securedCoveragePercent: number;
  outbound: string;
  inbound: string;
}>;

export type WalletAccountView = Readonly<{
  counterpartyId: string;
  status: string;
  currentHeight: number;
  pending: boolean;
  disputed: boolean;
  activeDispute: boolean;
  disputeRiskEvidenceComplete: boolean;
  crossJTargetDisputeRisk: Readonly<{
    tokenId: number;
    symbol: string;
    amountRaw: string;
    amount: string;
  }> | null;
  isLeftPerspective: boolean;
  workspaceStatus: string | null;
  workspaceHash: string | null;
  workspaceRevision: number | null;
  workspaceLocalIsExecutor: boolean;
  workspaceHasLocalHanko: boolean;
  workspaceHasPeerHanko: boolean;
  tokens: readonly WalletAccountTokenView[];
}>;

export type WalletBatchView = Readonly<{
  status: string | null;
  mode: 'draft' | 'sent' | null;
  draftCount: number;
  sentCount: number;
  hasDraftBatch: boolean;
  hasSentBatch: boolean;
  canBroadcast: boolean;
  reserveIssue: Readonly<{
    opType: string;
    tokenId: number;
    requiredAmountRaw: string;
    availableAfterDebtRaw: string;
    debtClaimPaidRaw: string;
  }> | null;
}>;

export type WalletEntityAccountsView = Readonly<{
  entityId: string;
  signerId: string;
  runtimeId: string;
  jurisdiction: string | null;
  jurisdictionRef: string | null;
  label: string;
  height: number;
  timestamp: number;
  reserves: readonly WalletBalanceView[];
  accounts: readonly WalletAccountView[];
  catalog: readonly WalletTokenCatalogView[];
  batch: WalletBatchView;
}>;

export type WalletAccountProjectionDeps = Readonly<{
  deriveDelta: (delta: Delta, isLeftPerspective: boolean) => DerivedDelta;
  getTokenMeta: (tokenId: number) => WalletTokenMeta;
  getKnownTokenIds: () => readonly number[];
  precision?: number;
  crossJRiskEvidenceComplete?: boolean;
}>;

const normalizeEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();

const counterpartyFor = (
  ownerEntityId: string,
  leftEntity: string,
  rightEntity: string,
): { counterpartyId: string; isLeftPerspective: boolean } => {
  const owner = normalizeEntityId(ownerEntityId);
  const left = normalizeEntityId(leftEntity);
  const right = normalizeEntityId(rightEntity);
  if (owner && owner === left && right) return { counterpartyId: right, isLeftPerspective: true };
  if (owner && owner === right && left) return { counterpartyId: left, isLeftPerspective: false };
  throw new Error(`WALLET_ACCOUNT_OWNER_MISMATCH:${owner || '<missing>'}:${left || '<missing>'}:${right || '<missing>'}`);
};

const tokenView = (
  tokenId: number,
  raw: bigint,
  deps: WalletAccountProjectionDeps,
): WalletBalanceView => {
  const token = deps.getTokenMeta(tokenId);
  return Object.freeze({
    tokenId,
    symbol: token.symbol,
    decimals: token.decimals,
    raw: raw.toString(),
    formatted: formatTokenAmount(raw, token.decimals, deps.precision ?? 4),
  });
};

const accountTokenView = (
  tokenId: number,
  delta: Delta,
  requestedRebalance: bigint,
  isLeftPerspective: boolean,
  deps: WalletAccountProjectionDeps,
): WalletAccountTokenView => {
  const derived = deps.deriveDelta(delta, isLeftPerspective);
  const token = deps.getTokenMeta(tokenId);
  const uncollateralized = derived.outPeerCredit > derived.outCollateral
    ? derived.outPeerCredit - derived.outCollateral
    : 0n;
  const securedCoverageBps = derived.outPeerCredit === 0n || derived.outCollateral >= derived.outPeerCredit
    ? 10_000n
    : derived.outCollateral * 10_000n / derived.outPeerCredit;
  return Object.freeze({
    ...tokenView(tokenId, derived.delta, deps),
    outboundRaw: derived.outCapacity.toString(),
    inboundRaw: derived.inCapacity.toString(),
    collateralRaw: derived.collateral.toString(),
    ownCreditLimitRaw: derived.ownCreditLimit.toString(),
    peerCreditLimitRaw: derived.peerCreditLimit.toString(),
    withdrawableCollateralRaw: derived.outCollateral.toString(),
    requestedRebalanceRaw: requestedRebalance.toString(),
    uncollateralizedRaw: uncollateralized.toString(),
    securedCoveragePercent: Number(securedCoverageBps) / 100,
    outbound: formatTokenAmount(derived.outCapacity, token.decimals, deps.precision ?? 4),
    inbound: formatTokenAmount(derived.inCapacity, token.decimals, deps.precision ?? 4),
  });
};

export const projectWalletAccountFrame = (
  frame: RuntimeAdapterViewFrame | null | undefined,
  deps: WalletAccountProjectionDeps,
): WalletEntityAccountsView | null => {
  const active = frame?.activeEntity;
  if (!active) return null;
  const entityId = normalizeEntityId(active.core.entityId || active.summary.entityId);
  if (!entityId) throw new Error('WALLET_ACCOUNT_ENTITY_ID_MISSING');

  const reserves = [...active.core.reserves.entries()]
    .map(([tokenId, amount]) => tokenView(Number(tokenId), amount, deps))
    .toSorted((left, right) => left.tokenId - right.tokenId);
  const catalog = [...new Set(deps.getKnownTokenIds())]
    .filter(id => Number.isSafeInteger(id) && id > 0)
    .map(id => Object.freeze({ tokenId: id, ...deps.getTokenMeta(id) }))
    .toSorted((left, right) => left.tokenId - right.tokenId);
  const accounts = active.accounts.items.map(account => {
    const perspective = counterpartyFor(entityId, account.state.leftEntity, account.state.rightEntity);
    const disputeRiskEvidenceComplete = deps.crossJRiskEvidenceComplete ?? true;
    const disputeRisk = disputeRiskEvidenceComplete
      ? getCrossJTargetDisputeRiskForProjection({
          entityId: active.core.entityId,
          crossJurisdictionSwaps: active.core.crossJurisdictionSwaps,
        }, account, perspective.counterpartyId)
      : null;
    const tokens = [...account.state.deltas.entries()]
      .map(([tokenId, delta]) => accountTokenView(
        Number(tokenId),
        delta,
        account.state.requestedRebalance?.get(Number(tokenId)) ?? 0n,
        perspective.isLeftPerspective,
        deps,
      ))
      .toSorted((left, right) => left.tokenId - right.tokenId);
    const workspace = account.state.settlementWorkspace;
    return Object.freeze({
      counterpartyId: perspective.counterpartyId,
      status: String(account.status || 'active'),
      currentHeight: Math.max(0, Math.floor(Number(account.currentHeight || 0))),
      pending: Boolean(account.pendingFrame) || (account.mempool?.length ?? 0) > 0,
      disputed: Boolean(account.activeDispute) || account.status === 'disputed',
      activeDispute: Boolean(account.activeDispute),
      disputeRiskEvidenceComplete,
      crossJTargetDisputeRisk: disputeRisk ? Object.freeze({
        tokenId: disputeRisk.tokenId,
        symbol: deps.getTokenMeta(disputeRisk.tokenId).symbol,
        amountRaw: disputeRisk.amount.toString(),
        amount: formatTokenAmount(
          disputeRisk.amount,
          deps.getTokenMeta(disputeRisk.tokenId).decimals,
          deps.precision ?? 4,
        ),
      }) : null,
      isLeftPerspective: perspective.isLeftPerspective,
      workspaceStatus: workspace?.status ?? null,
      workspaceHash: workspace?.workspaceHash ?? null,
      workspaceRevision: workspace ? Math.max(0, Math.floor(Number(workspace.revision))) : null,
      workspaceLocalIsExecutor: Boolean(workspace && workspace.executorIsLeft === perspective.isLeftPerspective),
      workspaceHasLocalHanko: Boolean(workspace && (perspective.isLeftPerspective ? workspace.leftHanko : workspace.rightHanko)),
      workspaceHasPeerHanko: Boolean(workspace && (perspective.isLeftPerspective ? workspace.rightHanko : workspace.leftHanko)),
      tokens: Object.freeze(tokens),
    });
  }).toSorted((left, right) => left.counterpartyId.localeCompare(right.counterpartyId));
  const batchState = buildPendingBatchState(active.core.jBatchState);
  const debtState = buildOpenOutgoingDebtByToken(active.core.outDebtsByToken);
  const reserveIssue = getPendingBatchReserveIssue({
    entityId,
    batch: active.core.jBatchState?.batch,
    onchainReserves: active.core.reserves,
    openDebtByToken: debtState.byToken,
  });

  return Object.freeze({
    entityId,
    signerId: normalizeEntityId(active.core.signerId || active.summary.signerId),
    runtimeId: normalizeEntityId(active.summary.runtimeId) || '',
    jurisdiction: active.summary.jurisdiction?.name ? String(active.summary.jurisdiction.name) : null,
    jurisdictionRef: getJurisdictionStackId(active.core.config.jurisdiction) || null,
    label: String(active.summary.label || active.core.profile?.name || entityId),
    height: Math.max(0, Math.floor(Number(frame.height || active.core.height || 0))),
    timestamp: Math.max(0, Math.floor(Number(active.core.timestamp || 0))),
    reserves: Object.freeze(reserves),
    accounts: Object.freeze(accounts),
    catalog: Object.freeze(catalog),
    batch: Object.freeze({
      status: active.core.jBatchState?.status ?? null,
      mode: batchState.mode,
      draftCount: batchState.draftCount,
      sentCount: batchState.sentCount,
      hasDraftBatch: batchState.hasDraftBatch,
      hasSentBatch: batchState.hasSentBatch,
      canBroadcast: canBroadcastPendingBatch(batchState, reserveIssue),
      reserveIssue: reserveIssue ? Object.freeze({
        opType: reserveIssue.opType,
        tokenId: reserveIssue.tokenId,
        requiredAmountRaw: reserveIssue.requiredAmount.toString(),
        availableAfterDebtRaw: reserveIssue.availableAfterDebt.toString(),
        debtClaimPaidRaw: reserveIssue.debtClaimPaid.toString(),
      }) : null,
    }),
  });
};
