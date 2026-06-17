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
import { handleCrossPullClose, handlePullCancel, handlePullLock, handlePullResolve } from './handlers/pull';
import { handleSwapOffer } from './handlers/swap-offer';
import { handleSwapResolve } from './handlers/swap-resolve';
import { handleCrossSwapFillAck } from './handlers/cross-swap-fill-ack';
import { handleSwapCancelRequest } from './handlers/swap-cancel';
import { handleSettleHold, handleSettleRelease } from './handlers/settle-hold';
import { handleJEventClaim } from './handlers/j-event-claim';
import { canProcessAccountTxForDisputeStatus } from '../account-dispute-policy';

type ProcessAccountTxResult = {
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
    createdHeight?: number;
    giveTokenId: number;
    giveAmount: bigint;
    wantTokenId: number;
    wantAmount: bigint;
    priceTicks?: bigint | undefined;
    timeInForce?: 0 | 1 | 2 | undefined;
    minFillRatio: number;
  };
  swapOfferCancelRequested?: { offerId: string };
  swapOfferCancelled?: { offerId: string; accountId: string; makerId?: string };
  pullResolved?: { pullId: string; fillRatio: number };
  pullCancelled?: { pullId: string; status: 'cancelled' | 'already-closed' };
};

type DebugEventEmitter = {
  sendDebugEvent(payload: Record<string, unknown>): void;
};

const isDebugEventEmitter = (value: unknown): value is DebugEventEmitter =>
  typeof value === 'object' &&
  value !== null &&
  'sendDebugEvent' in value &&
  typeof value.sendDebugEvent === 'function';

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
): Promise<ProcessAccountTxResult> {
  // Derive counterparty from canonical left/right using proofHeader's fromEntity as "me"
  const myEntityId = accountMachine.proofHeader.fromEntity;
  const { counterparty } = getAccountPerspective(accountMachine, myEntityId);

  const emitRebalanceDebug = (payload: Record<string, unknown>) => {
    const p2p = env?.runtimeState?.p2p;
    if (isDebugEventEmitter(p2p)) {
      p2p.sendDebugEvent({
        level: 'info',
        code: 'REB_STEP',
        accountId: counterparty,
        ...payload,
      });
    }
  };

  if (!canProcessAccountTxForDisputeStatus(accountMachine.status, accountTx.type)) {
    const error = `Account is ${accountMachine.status}; tx ${accountTx.type} rejected until dispute/reopen flow completes`;
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

    case 'account_settle':
      // Blockchain settlement - handled separately in entity-tx/handlers/account.ts
      return { success: false, events: ['❌ account_settle must not be processed here'], error: 'account_settle handled externally' };

    case 'reserve_to_collateral':
      return handleReserveToCollateral(
        accountMachine,
        accountTx,
      );

    case 'request_collateral':
      {
      const result = handleRequestCollateral(
        accountMachine,
        accountTx,
        byLeft,
        currentTimestamp,
      );
      const tokenId = Number(accountTx.data.tokenId);
      if (result.success) {
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
          tokenId,
        });
      }
      return result;
      }

    case 'set_rebalance_policy':
      return handleSetRebalancePolicy(
        accountMachine,
        accountTx,
        byLeft,
      );

    case 'reopen_disputed':
      return handleReopenDisputed(accountMachine, accountTx);

    case 'j_event_claim':
      return handleJEventClaim(
        accountMachine,
        accountTx,
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
        accountTx,
        byLeft,
        currentTimestamp,
        currentHeight,
        isValidation,
      );

    case 'htlc_resolve': {
      const resolveResult = await handleHtlcResolve(
        accountMachine,
        accountTx,
        byLeft,
        currentHeight,
        currentTimestamp,
      );
      const ret: ProcessAccountTxResult = {
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
      return ret;
    }

    case 'pull_lock':
      return await handlePullLock(
        accountMachine,
        accountTx,
        byLeft,
        currentHeight,
        currentTimestamp,
      );

    case 'pull_resolve':
      return await handlePullResolve(
        accountMachine,
        accountTx,
        byLeft,
        currentTimestamp,
      );

    case 'pull_cancel':
      return await handlePullCancel(
        accountMachine,
        accountTx,
        byLeft,
        currentTimestamp,
      );

    case 'cross_pull_close':
      return await handleCrossPullClose(
        accountMachine,
        accountTx,
        byLeft,
        currentTimestamp,
      );

    // === SWAP HANDLERS ===
    case 'swap_offer':
      return await handleSwapOffer(
        accountMachine,
        accountTx,
        byLeft,
        currentHeight,
        isValidation,
      );

    case 'swap_resolve':
      return await handleSwapResolve(
        accountMachine,
        accountTx,
        byLeft,
        currentHeight,
        isValidation,
      );

    case 'cross_swap_fill_ack':
      return await handleCrossSwapFillAck(
        accountMachine,
        accountTx,
        byLeft,
        currentHeight,
      );

    case 'swap_cancel_request':
      return await handleSwapCancelRequest(
        accountMachine,
        accountTx,
        byLeft,
        currentHeight,
        isValidation,
      );

    // === SETTLEMENT HOLD HANDLERS ===
    case 'settle_hold':
      return await handleSettleHold(accountMachine, accountTx);

    case 'settle_release':
      return await handleSettleRelease(accountMachine, accountTx);

    case 'account_frame':
      // This should never be called - frames are handled by frame-level consensus
      console.error(`❌ FATAL: account_frame should not be in accountTxs array!`);
      return { success: false, error: 'account_frame is not a transaction type', events: [] };

    default:
      {
        const unreachable: never = accountTx;
        const unknown = unreachable as { type?: unknown };
        return { success: false, error: `Unknown accountTx type: ${String(unknown.type)}`, events: [] };
      }
  }
}
