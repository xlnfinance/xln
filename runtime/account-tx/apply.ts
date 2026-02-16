/**
 * Account Transaction Dispatcher
 * Routes AccountTx to appropriate handlers (like entity-tx/apply.ts pattern)
 */

import type { AccountMachine, AccountTx } from '../types';
import { getAccountPerspective } from '../state-helpers';
import { handleAddDelta } from './handlers/add-delta';
import { handleSetCreditLimit } from './handlers/set-credit-limit';
import { handleDirectPayment } from './handlers/direct-payment';
import { handleReserveToCollateral } from './handlers/reserve-to-collateral';
import { handleRequestWithdrawal } from './handlers/request-withdrawal';
import { handleApproveWithdrawal } from './handlers/approve-withdrawal';
import { handleRequestRebalance } from './handlers/request-rebalance';
import { handleSetRebalancePolicy } from './handlers/set-rebalance-policy';
import { handleRebalanceRequest } from './handlers/rebalance-request';
import { handleRebalanceQuote } from './handlers/rebalance-quote';
import { handleRebalanceAccept } from './handlers/rebalance-accept';
import { handleRequestCollateral } from './handlers/request-collateral';
import { handleJSync } from './handlers/j-sync';
import { handleHtlcLock } from './handlers/htlc-lock';
// htlc_resolve: unified handler imported dynamically in switch case
import { handleSwapOffer } from './handlers/swap-offer';
import { handleSwapResolve } from './handlers/swap-resolve';
import { handleSwapCancel } from './handlers/swap-cancel';
import { handleSettleHold, handleSettleRelease } from './handlers/settle-hold';

/**
 * Process single AccountTx through bilateral consensus
 * @param accountMachine - The account machine state
 * @param accountTx - The transaction to process
 * @param byLeft - Frame-level: is the proposer the LEFT entity? (Channel.ts block.isLeft pattern)
 * @param currentTimestamp - Current timestamp (for HTLC timelock validation)
 * @param currentHeight - Current J-block height (for HTLC revealBeforeHeight validation)
 * @returns Result with success, events, and optional error (may include secret/hashlock for HTLC routing)
 */
export async function processAccountTx(
  accountMachine: AccountMachine,
  accountTx: AccountTx,
  byLeft: boolean,
  currentTimestamp: number = 0,
  currentHeight: number = 0,
  isValidation: boolean = false,
): Promise<{
  success: boolean;
  events: string[];
  error?: string;
  secret?: string;
  hashlock?: string;
  timedOutHashlock?: string;
  swapOfferCreated?: {
    offerId: string;
    makerIsLeft: boolean;
    fromEntity: string;
    toEntity: string;
    giveTokenId: number;
    giveAmount: bigint;
    wantTokenId: number;
    wantAmount: bigint;
    minFillRatio: number;
  };
  swapOfferCancelled?: { offerId: string; accountId: string; makerId?: string };
}> {
  // Derive counterparty from canonical left/right using proofHeader's fromEntity as "me"
  const myEntityId = accountMachine.proofHeader.fromEntity;
  const { counterparty } = getAccountPerspective(accountMachine, myEntityId);
  console.log(`🔄 Processing ${accountTx.type} for ${counterparty.slice(-4)} (byLeft: ${byLeft})`);

  // Route to appropriate handler based on transaction type
  switch (accountTx.type) {
    case 'add_delta':
      return handleAddDelta(accountMachine, accountTx);

    case 'set_credit_limit':
      return handleSetCreditLimit(accountMachine, accountTx, byLeft);

    case 'direct_payment':
      return handleDirectPayment(accountMachine, accountTx, byLeft);

    case 'account_payment':
      // Legacy type - not used in new implementation
      console.warn(`⚠️ account_payment type is deprecated`);
      return { success: true, events: [] };

    case 'account_settle':
      // Blockchain settlement - handled separately in entity-tx/handlers/account.ts
      console.log(`💰 account_settle processed externally`);
      return { success: true, events: [`⚖️ Settlement processed`] };

    case 'reserve_to_collateral':
      return handleReserveToCollateral(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'reserve_to_collateral' }>,
      );

    case 'request_withdrawal':
      return handleRequestWithdrawal(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'request_withdrawal' }>,
        byLeft,
      );

    case 'approve_withdrawal':
      return handleApproveWithdrawal(accountMachine, accountTx as Extract<AccountTx, { type: 'approve_withdrawal' }>);

    case 'request_rebalance':
      return handleRequestRebalance(accountMachine, accountTx as Extract<AccountTx, { type: 'request_rebalance' }>);

    case 'request_collateral':
      return handleRequestCollateral(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'request_collateral' }>,
        byLeft,
      );

    case 'set_rebalance_policy':
      return handleSetRebalancePolicy(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'set_rebalance_policy' }>,
        byLeft,
      );

    case 'rebalance_request':
      return handleRebalanceRequest(accountMachine, accountTx as Extract<AccountTx, { type: 'rebalance_request' }>);

    case 'rebalance_quote':
      return handleRebalanceQuote(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'rebalance_quote' }>,
        currentTimestamp,
      );

    case 'rebalance_accept':
      return handleRebalanceAccept(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'rebalance_accept' }>,
        currentTimestamp,
      );

    case 'j_sync':
      return handleJSync(accountMachine, accountTx as Extract<AccountTx, { type: 'j_sync' }>);

    case 'j_event_claim': {
      // Bilateral J-event consensus: Store observation with correct left/right attribution
      const { jHeight, jBlockHash, events, observedAt } = accountTx.data;
      console.log(`📥 j_event_claim: jHeight=${jHeight}, hash=${jBlockHash.slice(0, 10)}, byLeft=${byLeft}`);

      // Initialize consensus fields if missing
      if (!accountMachine.leftJObservations) accountMachine.leftJObservations = [];
      if (!accountMachine.rightJObservations) accountMachine.rightJObservations = [];
      if (!accountMachine.jEventChain) accountMachine.jEventChain = [];
      if (accountMachine.lastFinalizedJHeight === undefined) accountMachine.lastFinalizedJHeight = 0;

      // H17 FIX: Validate jHeight bounds (soft validation - warn but don't reject)
      // j_event_claim can be idempotent (same height re-claimed during consensus)
      // Only reject unreasonably large forward jumps
      const MAX_J_HEIGHT_JUMP = 10000;
      if (jHeight > accountMachine.lastFinalizedJHeight + MAX_J_HEIGHT_JUMP) {
        return {
          success: false,
          events: [`❌ j_event_claim: jHeight ${jHeight} too far ahead`],
          error: `Invalid jHeight: jump too large (max ${MAX_J_HEIGHT_JUMP})`,
        };
      }
      // Skip duplicate claims (already finalized this height)
      if (jHeight <= accountMachine.lastFinalizedJHeight) {
        console.log(
          `   ℹ️ j_event_claim: jHeight ${jHeight} already finalized (lastFinalized=${accountMachine.lastFinalizedJHeight}) - skipping`,
        );
        return { success: true, events: [`ℹ️ j_event_claim skipped (already finalized)`] };
      }

      // AUTH: byLeft = frame proposer is left (Channel.ts block.isLeft pattern)
      const { counterparty: cpId } = getAccountPerspective(accountMachine, myEntityId);
      const claimIsFromLeft = byLeft;

      console.log(`   🔍 AUTH: byLeft=${byLeft}, claimIsFromLeft=${claimIsFromLeft}`);

      const obs = { jHeight, jBlockHash, events, observedAt };

      // Store observation with correct left/right attribution
      if (claimIsFromLeft) {
        accountMachine.leftJObservations.push(obs);
        console.log(`   📝 Stored LEFT obs (${accountMachine.leftJObservations.length} total)`);
      } else {
        accountMachine.rightJObservations.push(obs);
        console.log(`   📝 Stored RIGHT obs (${accountMachine.rightJObservations.length} total)`);
      }

      // CRITICAL: Only finalize during COMMIT (on real accountMachine), not VALIDATION (on clone)
      // Validation happens on clonedMachine which gets discarded - finalization would be lost!
      // Frame delta comparison now uses offdelta only, which isn't affected by bilateral finalization.
      if (!isValidation) {
        const { tryFinalizeAccountJEvents } = await import('../entity-tx/j-events');
        tryFinalizeAccountJEvents(accountMachine, cpId, { timestamp: currentTimestamp });

        // DEBUG: Check if bilateral finalization persisted
        const delta = accountMachine.deltas.get(1); // USDC token
        console.log(
          `🔍 AFTER-BILATERAL-FINALIZE (isValidation=${isValidation}): collateral=${delta?.collateral || 0n}`,
        );
      } else {
        console.log(`⏭️ SKIP-BILATERAL-FINALIZE: On validation clone, will finalize during commit`);
      }

      return { success: true, events: [`📥 J-event claim processed`] };
    }

    // === HTLC HANDLERS ===
    case 'htlc_lock':
      return await handleHtlcLock(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'htlc_lock' }>,
        byLeft,
        currentTimestamp,
        currentHeight,
        isValidation,
      );

    case 'htlc_resolve': {
      const { handleHtlcResolve } = await import('./handlers/htlc-resolve');
      const resolveResult = await handleHtlcResolve(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'htlc_resolve' }>,
        currentHeight,
        currentTimestamp,
      );
      const ret: typeof processAccountTx extends (...args: any[]) => Promise<infer R> ? R : never = {
        success: resolveResult.success,
        events: resolveResult.events,
      };
      if (resolveResult.error) ret.error = resolveResult.error;
      if (resolveResult.secret) ret.secret = resolveResult.secret;
      if (resolveResult.hashlock) ret.hashlock = resolveResult.hashlock;
      if (resolveResult.outcome === 'error' && resolveResult.hashlock) ret.timedOutHashlock = resolveResult.hashlock;
      return ret;
    }

    // === SWAP HANDLERS ===
    case 'swap_offer':
      return await handleSwapOffer(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'swap_offer' }>,
        byLeft,
        currentHeight,
        isValidation,
      );

    case 'swap_resolve':
      return await handleSwapResolve(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'swap_resolve' }>,
        byLeft,
        currentHeight,
        isValidation,
      );

    case 'swap_cancel':
      return await handleSwapCancel(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'swap_cancel' }>,
        byLeft,
        currentHeight,
        isValidation,
      );

    // === SETTLEMENT HOLD HANDLERS ===
    case 'settle_hold':
      return await handleSettleHold(accountMachine, accountTx as Extract<AccountTx, { type: 'settle_hold' }>);

    case 'settle_release':
      return await handleSettleRelease(accountMachine, accountTx as Extract<AccountTx, { type: 'settle_release' }>);

    case 'account_frame':
      // This should never be called - frames are handled by frame-level consensus
      console.error(`❌ FATAL: account_frame should not be in accountTxs array!`);
      return { success: false, error: 'account_frame is not a transaction type', events: [] };

    default:
      // Type-safe error handling for unknown AccountTx types
      return { success: false, error: `Unknown accountTx type`, events: [] };
  }
}
