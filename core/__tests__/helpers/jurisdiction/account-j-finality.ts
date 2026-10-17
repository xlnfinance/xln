import type { AccountReplica } from '../../../types/account';
import type { JurisdictionEvent } from '../../../types/jurisdiction-events';
import { applyFinalizedAccountJEventsOnView } from '../../../account/tx/handlers/j-events/finality';
import {
  accountTransitionView,
  beginAccountTransition,
  discardAccountTransition,
  publishAccountTransition,
} from '../../../account/state/candidate-overlay';

/**
 * Test-only: apply finalized AccountSettled events to a live replica through
 * one Account overlay, exactly as the j_event_claim handler does in production.
 */
export const applyFinalizedAccountJEvents = (
  account: AccountReplica,
  counterpartyId: string,
  events: readonly JurisdictionEvent[],
  deltaTransformerAddress: string,
): void => {
  const overlay = beginAccountTransition(account);
  try {
    applyFinalizedAccountJEventsOnView(accountTransitionView(overlay), counterpartyId, events, deltaTransformerAddress);
    publishAccountTransition(account, overlay, 'jFinality');
  } catch (error) {
    if (overlay.lifecycle.status === 'active') discardAccountTransition(overlay);
    throw error;
  }
};
