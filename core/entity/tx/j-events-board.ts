import { haltRuntimeFailure } from "../../protocol/errors/failure-taxonomy";

import { addMessage } from '../frame-events';
import {
  applyCertifiedBoardRegistryEvent,
  cacheCertifiedBoardNodes,
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardRecord,
} from '../../jurisdiction/machine/board-registry';
import { cancelHook, scheduleHook } from '../scheduler';
import {
  BOARD_HANKO_REFRESH_HOOK_ID,
  markBoardRotationHankoRefreshesPending,
} from './state-effects/board-rotation-hanko-refresh';
import type { FinalizedJEventContext } from './j-events';

export const COUNTERPARTY_BOARD_HANKO_REFRESH_DEADLINE_MS = 24 * 60 * 60 * 1_000;

export const counterpartyBoardHankoRefreshDeadlineHookId = (
  counterpartyId: string,
  activationJHeight: number,
  activationLogIndex: number,
): string => `counterparty-board-hanko-refresh:${counterpartyId.toLowerCase()}:${activationJHeight}:${activationLogIndex}`;

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
    throw haltRuntimeFailure("J_EVENT_BOARD_ROUTE_MISMATCH", `J_EVENT_BOARD_ROUTE_MISMATCH:${event.type}`);
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

  const boardHankoRefresh = markBoardRotationHankoRefreshesPending(newState, event);
  for (const accountId of boardHankoRefresh.dirtyAccounts) dirtyAccounts.add(accountId);
  if (!isLocalEntity) {
    const counterpartyId = event.data.entityId.toLowerCase();
    const account = newState.accounts.get(counterpartyId);
    if (!account || Number(account.currentHeight) < 1) return;
    if (!newState.crontabState) throw new Error('COUNTERPARTY_BOARD_HANKO_REFRESH_CRONTAB_MISSING');
    scheduleHook(newState.crontabState, {
      id: counterpartyBoardHankoRefreshDeadlineHookId(
        counterpartyId,
        boardHankoRefresh.activation.jHeight,
        boardHankoRefresh.activation.logIndex,
      ),
      triggerAt: newState.timestamp + COUNTERPARTY_BOARD_HANKO_REFRESH_DEADLINE_MS,
      type: 'counterparty_board_hanko_refresh_deadline',
      data: {
        accountId: counterpartyId,
        activationJHeight: boardHankoRefresh.activation.jHeight,
        activationLogIndex: boardHankoRefresh.activation.logIndex,
      },
    });
    addMessage(
      newState,
      `⏳ Awaiting current-board Account Hanko refresh from ${counterpartyId.slice(-4)} within 24h`,
    );
    return;
  }
  if (boardHankoRefresh.dirtyAccounts.length === 0) {
    if (newState.crontabState) cancelHook(newState.crontabState, BOARD_HANKO_REFRESH_HOOK_ID);
    return;
  }
  if (!newState.crontabState) throw new Error('BOARD_HANKO_REFRESH_CRONTAB_MISSING');
  scheduleHook(newState.crontabState, {
    id: BOARD_HANKO_REFRESH_HOOK_ID,
    triggerAt: newState.timestamp,
    type: 'board_hanko_refresh',
    data: {
      activationJHeight: boardHankoRefresh.activation.jHeight,
      activationLogIndex: boardHankoRefresh.activation.logIndex,
      afterCounterpartyId: '',
    },
  });
};
