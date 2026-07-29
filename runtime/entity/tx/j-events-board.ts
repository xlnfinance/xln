import { addMessage } from '../frame-events';
import {
  applyCertifiedBoardRegistryEvent,
  cacheCertifiedBoardNodes,
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardRecord,
} from '../../jurisdiction/board-registry';
import { cancelHook, scheduleHook } from '../scheduler';
import {
  BOARD_RESEAL_HOOK_ID,
  markBoardRotationResealsPending,
} from './board-rotation-reseal';
import type { FinalizedJEventContext } from './j-events';

/**
 * Applies the three events that advance certified board authority. Pending
 * EntityProvider actions are compared only with the newly certified epoch.
 */
export const applyCertifiedBoardJEvent = (
  context: FinalizedJEventContext,
): void => {
  const { newState, event, env, blockNumber, dirtyAccounts } = context;
  if (
    event.type !== 'FoundationBootstrapped' &&
    event.type !== 'EntityRegistered' &&
    event.type !== 'BoardActivated'
  ) {
    throw new Error(`J_EVENT_BOARD_ROUTE_MISMATCH:${event.type}`);
  }
  const jurisdiction = newState.config.jurisdiction;
  if (!jurisdiction) throw new Error('CERTIFIED_BOARD_ENTITY_JURISDICTION_MISSING');
  const applied = applyCertifiedBoardRegistryEvent(
    newState.certifiedBoardState,
    getCertifiedBoardNodeStore(env),
    jurisdiction,
    event,
  );
  cacheCertifiedBoardNodes(env, applied.newNodes);
  newState.certifiedBoardState = applied.state;
  addMessage(newState, `🔐 BOARD AUTHORITY: ${event.type} | Block ${blockNumber}`);
  if (event.type !== 'BoardActivated') return;

  const isLocalEntity =
    event.data.entityId.toLowerCase() === newState.entityId.toLowerCase();
  const pending = newState.entityProviderActionState?.pending;
  if (isLocalEntity && pending) {
    const certifiedBoard = resolveObserverCertifiedBoardRecord(
      newState,
      getCertifiedBoardNodeStore(env),
      newState.entityId,
    );
    if (!certifiedBoard) {
      throw new Error(`ENTITY_PROVIDER_ACTION_CERTIFIED_BOARD_MISSING:${newState.entityId}`);
    }
    const certifiedEpoch = BigInt(certifiedBoard.boardEpoch);
    if (pending.boardEpoch > certifiedEpoch) {
      throw new Error(
        `ENTITY_PROVIDER_ACTION_PENDING_BOARD_EPOCH_AHEAD:` +
        `${pending.boardEpoch.toString()}:${certifiedEpoch.toString()}`,
      );
    }
    if (pending.boardEpoch < certifiedEpoch) {
      delete newState.entityProviderActionState!.pending;
      addMessage(newState, '🛑 Pending EntityProvider action expired at board activation');
    }
  }

  const reseal = markBoardRotationResealsPending(newState, event);
  for (const accountId of reseal.dirtyAccounts) dirtyAccounts.add(accountId);
  if (!isLocalEntity) return;
  if (reseal.dirtyAccounts.length === 0) {
    if (newState.crontabState) cancelHook(newState.crontabState, BOARD_RESEAL_HOOK_ID);
    return;
  }
  if (!newState.crontabState) throw new Error('BOARD_RESEAL_CRONTAB_MISSING');
  scheduleHook(newState.crontabState, {
    id: BOARD_RESEAL_HOOK_ID,
    triggerAt: newState.timestamp,
    type: 'board_reseal',
    data: {
      activationJHeight: reseal.activation.jHeight,
      activationLogIndex: reseal.activation.logIndex,
      afterCounterpartyId: '',
    },
  });
};
