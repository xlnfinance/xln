/**
 * Account Transaction Dispatcher
 * Routes AccountTx to appropriate handlers (like entity-tx/apply.ts pattern)
 */

import type { AccountMachine, AccountTx, Env } from '../types';
import { getAccountPerspective } from '../state-helpers';
import { handleAddDelta } from './handlers/add-delta';
import { handleSetCreditLimit } from './handlers/set-credit-limit';
import { handleDirectPayment } from './handlers/direct-payment';
import { handleReserveToCollateral } from './handlers/reserve-to-collateral';
import { handleSetRebalancePolicy } from './handlers/set-rebalance-policy';
import { handleRequestCollateral } from './handlers/request-collateral';
import { handleReopenDisputed } from './handlers/reopen-disputed';
import { handleHtlcLock } from './handlers/htlc-lock';
import { handleHtlcResolve } from './handlers/htlc-resolve';
import { handleSwapOffer } from './handlers/swap-offer';
import { handleSwapResolve } from './handlers/swap-resolve';
import { handleSwapCancelRequest } from './handlers/swap-cancel';
import { handleSettleHold, handleSettleRelease } from './handlers/settle-hold';
import { handleJEventClaim } from './handlers/j-event-claim';

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
  env?: Env,
): Promise<{
  success: boolean;
  events: string[];
  error?: string;
  secret?: string;
  hashlock?: string;
  timedOutHashlock?: string;
  finalRecipient?: boolean;
  amount?: bigint;
  tokenId?: number;
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
  swapOfferCancelRequested?: { offerId: string; accountId: string };
  swapOfferCancelled?: { offerId: string; accountId: string; makerId?: string };
}> {
  // Derive counterparty from canonical left/right using proofHeader's fromEntity as "me"
  const myEntityId = accountMachine.proofHeader.fromEntity;
  const { counterparty } = getAccountPerspective(accountMachine, myEntityId);
  console.log(`🔄 Processing ${accountTx.type} for ${counterparty.slice(-4)} (byLeft: ${byLeft})`);

  const emitRebalanceDebug = (payload: Record<string, unknown>) => {
    const p2p = (env as any)?.runtimeState?.p2p;
    if (p2p && typeof p2p.sendDebugEvent === 'function') {
      p2p.sendDebugEvent({
        level: 'info',
        code: 'REB_STEP',
        accountId: counterparty,
        ...payload,
      });
    }
  };

  if (
    (accountMachine.status ?? 'active') === 'disputed' &&
    accountTx.type !== 'j_event_claim' &&
    accountTx.type !== 'reopen_disputed'
  ) {
    const error = `Account is disputed; tx ${accountTx.type} rejected until reopen_disputed`;
    return { success: false, events: [error], error };
  }

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
      return { success: false, events: ['❌ account_payment is deprecated'], error: 'account_payment is deprecated' };

    case 'account_settle':
      // Blockchain settlement - handled separately in entity-tx/handlers/account.ts
      return { success: false, events: ['❌ account_settle must not be processed here'], error: 'account_settle handled externally' };

    case 'reserve_to_collateral':
      return handleReserveToCollateral(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'reserve_to_collateral' }>,
      );

    case 'request_collateral':
      {
      const result = handleRequestCollateral(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'request_collateral' }>,
        byLeft,
        currentTimestamp,
      );
      if (result.success) {
        const tokenId = Number((accountTx as any)?.data?.tokenId ?? 0);
        const requested = accountMachine.requestedRebalance.get(tokenId) ?? 0n;
        const feeState = accountMachine.requestedRebalanceFeeState?.get(tokenId);
        if (env && !isValidation) {
          env.emit('request_collateral_committed', {
            entityId: myEntityId,
            accountId: counterparty,
            tokenId,
            requestedAmount: requested.toString(),
            prepaidFee: String(feeState?.feePaidUpfront ?? 0n),
            requestedAt: Number(feeState?.requestedAt ?? currentTimestamp),
          });
        }
        emitRebalanceDebug({
          step: 1,
          status: 'ok',
          event: 'request_collateral_committed',
          tokenId,
          requestedAmount: requested.toString(),
          prepaidFee: String(feeState?.feePaidUpfront ?? 0n),
          requestedAt: Number(feeState?.requestedAt ?? currentTimestamp),
        });
      } else {
        emitRebalanceDebug({
          step: 1,
          status: 'error',
          event: 'request_collateral_rejected',
          reason: result.error || 'unknown',
          tokenId: Number((accountTx as any)?.data?.tokenId ?? 0),
        });
      }
      return result;
      }

    case 'set_rebalance_policy':
      return handleSetRebalancePolicy(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'set_rebalance_policy' }>,
        byLeft,
      );

    case 'reopen_disputed':
      return handleReopenDisputed(accountMachine, accountTx as Extract<AccountTx, { type: 'reopen_disputed' }>);

    case 'j_event_claim':
      return handleJEventClaim(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'j_event_claim' }>,
        byLeft,
        currentTimestamp,
        isValidation,
        myEntityId,
        emitRebalanceDebug,
        env,
      );

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
      if (resolveResult.finalRecipient !== undefined) ret.finalRecipient = resolveResult.finalRecipient;
      if (resolveResult.amount !== undefined) ret.amount = resolveResult.amount;
      if (resolveResult.tokenId !== undefined) ret.tokenId = resolveResult.tokenId;
      if (resolveResult.outcome === 'error' && resolveResult.hashlock) ret.timedOutHashlock = resolveResult.hashlock;
      if (resolveResult.outcome === 'secret' && resolveResult.finalRecipient === true && env && !isValidation) {
        env.emit('HtlcReceived', {
          entityId: myEntityId,
          fromEntity: counterparty,
          hashlock: resolveResult.hashlock,
          amount: resolveResult.amount?.toString(),
          tokenId: resolveResult.tokenId,
        });
      }
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

    case 'swap_cancel_request':
    case 'swap_cancel': // legacy alias
      return await handleSwapCancelRequest(
        accountMachine,
        accountTx as Extract<AccountTx, { type: 'swap_cancel_request' }> | Extract<AccountTx, { type: 'swap_cancel' }>,
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
