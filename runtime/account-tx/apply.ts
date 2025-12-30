/**
 * Account Transaction Dispatcher
 * Routes AccountTx to appropriate handlers (like entity-tx/apply.ts pattern)
 */

import { AccountMachine, AccountTx } from '../types';
import { getAccountPerspective } from '../state-helpers';
import { handleAddDelta } from './handlers/add-delta';
import { handleSetCreditLimit } from './handlers/set-credit-limit';
import { handleDirectPayment } from './handlers/direct-payment';
import { handleReserveToCollateral } from './handlers/reserve-to-collateral';
import { handleRequestWithdrawal } from './handlers/request-withdrawal';
import { handleApproveWithdrawal } from './handlers/approve-withdrawal';
import { handleRequestRebalance } from './handlers/request-rebalance';
import { handleJSync } from './handlers/j-sync';
import { handleHtlcLock } from './handlers/htlc-lock';
import { handleHtlcReveal } from './handlers/htlc-reveal';
import { handleHtlcTimeout } from './handlers/htlc-timeout';
import { handleSwapOffer } from './handlers/swap-offer';
import { handleSwapResolve } from './handlers/swap-resolve';
import { handleSwapCancel } from './handlers/swap-cancel';

/**
 * Process single AccountTx through bilateral consensus
 * @param accountMachine - The account machine state
 * @param accountTx - The transaction to process
 * @param isOurFrame - Whether we're processing our own frame (vs counterparty's)
 * @param currentTimestamp - Current timestamp (for HTLC timelock validation)
 * @param currentHeight - Current J-block height (for HTLC revealBeforeHeight validation)
 * @returns Result with success, events, and optional error (may include secret/hashlock for HTLC routing)
 */
export async function processAccountTx(
  accountMachine: AccountMachine,
  accountTx: AccountTx,
  isOurFrame: boolean = true,
  currentTimestamp: number = Date.now(),
  currentHeight: number = 0
): Promise<{ success: boolean; events: string[]; error?: string; secret?: string; hashlock?: string }> {
  // Derive counterparty from canonical left/right using proofHeader's fromEntity as "me"
  const myEntityId = accountMachine.proofHeader.fromEntity;
  const { counterparty } = getAccountPerspective(accountMachine, myEntityId);
  console.log(`🔄 Processing ${accountTx.type} for ${counterparty.slice(-4)} (ourFrame: ${isOurFrame})`);

  // Route to appropriate handler based on transaction type
  switch (accountTx.type) {
    case 'add_delta':
      return handleAddDelta(accountMachine, accountTx, isOurFrame);

    case 'set_credit_limit':
      return handleSetCreditLimit(accountMachine, accountTx, isOurFrame);

    case 'direct_payment':
      return handleDirectPayment(accountMachine, accountTx, isOurFrame);

    case 'account_payment':
      // Legacy type - not used in new implementation
      console.warn(`⚠️ account_payment type is deprecated`);
      return { success: true, events: [] };

    case 'account_settle':
      // Blockchain settlement - handled separately in entity-tx/handlers/account.ts
      console.log(`💰 account_settle processed externally`);
      return { success: true, events: [`⚖️ Settlement processed`] };

    case 'reserve_to_collateral':
      return handleReserveToCollateral(accountMachine, accountTx as Extract<AccountTx, { type: 'reserve_to_collateral' }>);

    case 'request_withdrawal':
      return handleRequestWithdrawal(accountMachine, accountTx as Extract<AccountTx, { type: 'request_withdrawal' }>, isOurFrame);

    case 'approve_withdrawal':
      return handleApproveWithdrawal(accountMachine, accountTx as Extract<AccountTx, { type: 'approve_withdrawal' }>);

    case 'request_rebalance':
      return handleRequestRebalance(accountMachine, accountTx as Extract<AccountTx, { type: 'request_rebalance' }>);

    case 'j_sync':
      return handleJSync(accountMachine, accountTx as Extract<AccountTx, { type: 'j_sync' }>, isOurFrame);

    case 'j_event_claim': {
      // Bilateral J-event consensus: Counterparty claims they observed a j-event
      const { jHeight, jBlockHash, events, observedAt } = accountTx.data;
      console.log(`📥 j_event_claim: Counterparty claims jHeight=${jHeight}, hash=${jBlockHash.slice(0,10)}`);

      // Initialize consensus fields if missing
      if (!accountMachine.leftJObservations) accountMachine.leftJObservations = [];
      if (!accountMachine.rightJObservations) accountMachine.rightJObservations = [];
      if (!accountMachine.jEventChain) accountMachine.jEventChain = [];
      if (accountMachine.lastFinalizedJHeight === undefined) accountMachine.lastFinalizedJHeight = 0;

      // Determine which side counterparty is using canonical left/right
      // proofHeader.fromEntity = our entity ID (perspective-dependent)
      const { iAmLeft, counterparty: cpId } = getAccountPerspective(accountMachine, myEntityId);
      const theyAreLeft = !iAmLeft;

      console.log(`   🔍 HANDLER: fromEntity=${myEntityId.slice(-4)}, counterparty=${cpId.slice(-4)}`);
      console.log(`   🔍 HANDLER: iAmLeft=${iAmLeft}, theyAreLeft=${theyAreLeft}`);

      const obs = { jHeight, jBlockHash, events, observedAt };

      // Store THEIR observation in appropriate array
      if (theyAreLeft) {
        accountMachine.leftJObservations.push(obs);
        console.log(`   📝 Stored LEFT obs from counterparty (${accountMachine.leftJObservations.length} total)`);
      } else {
        accountMachine.rightJObservations.push(obs);
        console.log(`   📝 Stored RIGHT obs from counterparty (${accountMachine.rightJObservations.length} total)`);
      }

      // Try finalize if both sides have matching observations
      const { tryFinalizeAccountJEvents } = await import('../entity-tx/j-events');
      tryFinalizeAccountJEvents(accountMachine, cpId, { timestamp: currentTimestamp });

      return { success: true, events: [`📥 J-event claim processed`] };
    }

    // === HTLC HANDLERS ===
    case 'htlc_lock':
      return await handleHtlcLock(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'htlc_lock' }>,
        isOurFrame,
        currentTimestamp,
        currentHeight
      );

    case 'htlc_reveal':
      return await handleHtlcReveal(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'htlc_reveal' }>,
        isOurFrame,
        currentHeight
      );

    case 'htlc_timeout':
      return await handleHtlcTimeout(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'htlc_timeout' }>,
        isOurFrame,
        currentHeight
      );

    // === SWAP HANDLERS ===
    case 'swap_offer':
      return await handleSwapOffer(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'swap_offer' }>,
        isOurFrame,
        currentHeight
      );

    case 'swap_resolve':
      return await handleSwapResolve(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'swap_resolve' }>,
        isOurFrame,
        currentHeight
      );

    case 'swap_cancel':
      return await handleSwapCancel(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'swap_cancel' }>,
        isOurFrame,
        currentHeight
      );

    case 'account_frame':
      // This should never be called - frames are handled by frame-level consensus
      console.error(`❌ FATAL: account_frame should not be in accountTxs array!`);
      return { success: false, error: 'account_frame is not a transaction type', events: [] };

    default:
      // Type-safe error handling for unknown AccountTx types
      return { success: false, error: `Unknown accountTx type`, events: [] };
  }
}
