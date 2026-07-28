/**
 * Stable dispute façade.
 *
 * Preparation owns local orderbook cleanup and the evidence cooldown. Start
 * and finalize live in separate protocol phases so their proof selection and
 * J-batch mutations can be audited independently.
 */

import type {
  AccountState,
  EntityInput,
  EntityState,
  EntityTx,
  RuntimeState,
  RuntimeOverlayRecord,
  SwapOffer,
} from '../../../types';
import { addMessage, cloneEntityState } from '../../../state-helpers';
import { freezeAccountForDispute } from '../../../account/consensus/dispute-policy';
import { removeBookOrderById } from '../../../orderbook/cross-j';
import { swapKey } from '../../../orderbook/swap-keys';
import { crossJurisdictionBookOwnerRef } from '../../../extensions/cross-j/orderbook';
import { crossJurisdictionRouteSignerHint } from '../cross-j-outputs';
import { collectDisputeEvidenceReadinessIssues } from './dispute/shared';
import { handleDisputeStart } from './dispute/start';

export { canonicalizeProofBodyStruct } from './dispute/shared';
export { handleDisputeFinalize } from './dispute/finalize';
export { handleDisputeStart } from './dispute/start';

const removeOrderbookRowForDispute = (
  state: EntityState,
  outputs: EntityInput[],
  counterpartyEntityId: string,
  offerId: string,
  offer: SwapOffer,
  storageChanges: RuntimeOverlayRecord[],
): { localRemoved: boolean; remoteQueued: boolean } => {
  // Once preparation freezes Account consensus, its resting orders must stop
  // matching before calldata is committed. A later fill could otherwise target
  // a ProofBody that this frozen account can no longer acknowledge.
  if (!offer.crossJurisdiction) {
    return {
      localRemoved: removeBookOrderById(
        state,
        swapKey(counterpartyEntityId, offerId),
        storageChanges,
      ),
      remoteQueued: false,
    };
  }
  const route = offer.crossJurisdiction;
  const bookOwnerEntityId = crossJurisdictionBookOwnerRef(route);
  const sourceEntityId = route.source.entityId;
  if (bookOwnerEntityId === String(state.entityId).toLowerCase()) {
    return {
      localRemoved: removeBookOrderById(
        state,
        swapKey(sourceEntityId, offerId),
        storageChanges,
      ),
      remoteQueued: false,
    };
  }
  const signerId = crossJurisdictionRouteSignerHint(route, bookOwnerEntityId);
  if (!signerId) {
    throw new Error(
      `DISPUTE_CROSS_J_BOOK_OWNER_SIGNER_MISSING: order=${offerId} ` +
      `owner=${bookOwnerEntityId} source=${sourceEntityId}`,
    );
  }
  outputs.push({
    entityId: bookOwnerEntityId,
    signerId,
    entityTxs: [{
      type: 'removeCrossJurisdictionBookOrder',
      data: {
        orderId: offerId,
        sourceEntityId,
        sourceAccountId: counterpartyEntityId,
        route,
        reason: 'account_dispute_prepare',
      },
    }],
  });
  return { localRemoved: false, remoteQueued: true };
};

const removeDisputedAccountOrdersFromBook = (
  state: EntityState,
  outputs: EntityInput[],
  counterpartyEntityId: string,
  account: AccountState,
  storageChanges: RuntimeOverlayRecord[],
): { remoteOrderIds: string[] } => {
  let localRemoved = 0;
  let remoteQueued = 0;
  const remoteOrderIds: string[] = [];
  for (const [offerId, offer] of account.swapOffers ?? new Map<string, SwapOffer>()) {
    const result = removeOrderbookRowForDispute(
      state,
      outputs,
      counterpartyEntityId,
      offerId,
      offer,
      storageChanges,
    );
    if (result.localRemoved) localRemoved++;
    if (result.remoteQueued) {
      remoteQueued++;
      remoteOrderIds.push(offerId);
    }
  }
  if (localRemoved > 0 || remoteQueued > 0) {
    addMessage(
      state,
      `⚔️ Dispute removed ${localRemoved} local orderbook row(s), ` +
      `queued ${remoteQueued} remote row removal(s)`,
    );
  }
  return { remoteOrderIds };
};

const markAccountDisputePreparing = (
  state: EntityState,
  account: AccountState,
  description: string,
  minCooldownMs: number,
  pendingOrderbookRemovalIds: readonly string[],
  startIntent: NonNullable<AccountState['disputePrepare']>['startIntent'],
): void => {
  const startedAt = Number(state.timestamp ?? 0);
  account.status = 'dispute_preparing';
  account.disputePrepare = {
    startedAt,
    readyAfter: startedAt + Math.max(0, Math.floor(minCooldownMs)),
    reason: description || 'prepare-dispute',
    ...(pendingOrderbookRemovalIds.length > 0
      ? { pendingOrderbookRemovalIds: [...pendingOrderbookRemovalIds].sort() }
      : {}),
    ...(startIntent ? { startIntent } : {}),
  };
  // Optional resolution evidence may still arrive, but ordinary bilateral
  // proposals must stop changing the signed ProofBody during preparation.
  freezeAccountForDispute(account, true);
};

const buildDisputeStartIntent = (
  tx: Extract<EntityTx, { type: 'prepareDispute' }>,
): NonNullable<AccountState['disputePrepare']>['startIntent'] => ({
  description: tx.data.description ?? 'prepare-dispute',
  ...(tx.data.crossJurisdictionRouteId !== undefined
    ? { crossJurisdictionRouteId: tx.data.crossJurisdictionRouteId }
    : {}),
  ...(tx.data.starterInitialArguments !== undefined
    ? { starterInitialArguments: tx.data.starterInitialArguments }
    : {}),
  ...(tx.data.allowUnsafeCrossJTargetDispute === true
    ? { allowUnsafeCrossJTargetDispute: true }
    : {}),
  ...(tx.data.acceptedCrossJTargetLossAmount !== undefined
    ? { acceptedCrossJTargetLossAmount: tx.data.acceptedCrossJTargetLossAmount }
    : {}),
});

export const draftPreparedDisputeStartIfReady = async (
  entityState: EntityState,
  counterpartyEntityId: string,
  env: RuntimeState,
  storageChanges: RuntimeOverlayRecord[] = [],
): Promise<{ newState: EntityState; outputs: EntityInput[] }> => {
  const account = entityState.accounts.get(counterpartyEntityId);
  if (!account || (account.status ?? 'active') !== 'dispute_preparing') {
    return { newState: entityState, outputs: [] };
  }
  const issues = collectDisputeEvidenceReadinessIssues(
    account,
    Number(entityState.timestamp ?? 0),
  );
  if (issues.length > 0) return { newState: entityState, outputs: [] };
  const intent = account.disputePrepare?.startIntent;
  return handleDisputeStart(
    entityState,
    {
      type: 'disputeStart',
      data: {
        counterpartyEntityId,
        ...(intent?.description !== undefined ? { description: intent.description } : {}),
        ...(intent?.crossJurisdictionRouteId !== undefined
          ? { crossJurisdictionRouteId: intent.crossJurisdictionRouteId }
          : {}),
        ...(intent?.starterInitialArguments !== undefined
          ? { starterInitialArguments: intent.starterInitialArguments }
          : {}),
        ...(intent?.allowUnsafeCrossJTargetDispute === true
          ? { allowUnsafeCrossJTargetDispute: true }
          : {}),
        ...(intent?.acceptedCrossJTargetLossAmount !== undefined
          ? { acceptedCrossJTargetLossAmount: intent.acceptedCrossJTargetLossAmount }
          : {}),
      },
    },
    env,
    storageChanges,
  );
};

export const handlePrepareDispute = async (
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'prepareDispute' }>,
  env: RuntimeState,
  storageChanges: RuntimeOverlayRecord[] = [],
): Promise<{ newState: EntityState; outputs: EntityInput[] }> => {
  const counterpartyEntityId = entityTx.data.counterpartyEntityId;
  const description = entityTx.data.description ?? 'prepare-dispute';
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) {
    addMessage(
      newState,
      `❌ No account with ${counterpartyEntityId.slice(-4)} - cannot prepare dispute`,
    );
    return { newState, outputs };
  }
  if (account.activeDispute || (account.status ?? 'active') === 'disputed') {
    addMessage(
      newState,
      `ℹ️ Dispute already active/queued for ${counterpartyEntityId.slice(-4)}`,
    );
    return { newState, outputs };
  }
  if ((account.status ?? 'active') === 'dispute_preparing') {
    const issues = collectDisputeEvidenceReadinessIssues(
      account,
      Number(newState.timestamp ?? 0),
    );
    if (issues.length === 0) {
      return draftPreparedDisputeStartIfReady(
        newState,
        counterpartyEntityId,
        env,
        storageChanges,
      );
    }
    addMessage(
      newState,
      `⏳ Dispute preparation still pending for ${counterpartyEntityId.slice(-4)}: ` +
      issues.join('; '),
    );
    return { newState, outputs };
  }
  const removal = removeDisputedAccountOrdersFromBook(
    newState,
    outputs,
    counterpartyEntityId,
    account,
    storageChanges,
  );
  markAccountDisputePreparing(
    newState,
    account,
    description,
    entityTx.data.minCooldownMs ?? 0,
    removal.remoteOrderIds,
    buildDisputeStartIntent(entityTx),
  );
  const issues = collectDisputeEvidenceReadinessIssues(
    account,
    Number(newState.timestamp ?? 0),
  );
  addMessage(
    newState,
    issues.length > 0
      ? `⏳ Dispute prepared vs ${counterpartyEntityId.slice(-4)}; ` +
        `waiting for stable evidence: ${issues.join('; ')}`
      : `⏳ Dispute prepared vs ${counterpartyEntityId.slice(-4)}; ` +
        'evidence currently stable, queue disputeStart when ready',
  );
  if (issues.length > 0) return { newState, outputs };
  const drafted = await draftPreparedDisputeStartIfReady(
    newState,
    counterpartyEntityId,
    env,
    storageChanges,
  );
  return {
    newState: drafted.newState,
    outputs: [...outputs, ...drafted.outputs],
  };
};
