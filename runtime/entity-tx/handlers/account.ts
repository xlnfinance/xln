import { AccountInput, AccountTx, EntityState, Env, EntityInput, EntityTx } from '../../types';
import { handleAccountInput as processAccountInput } from '../../account-consensus';
import { cloneEntityState, addMessage, addMessages, canonicalAccountKey, getAccountPerspective } from '../../state-helpers';
import { applyCommand, createBook, canonicalPair, deriveSide, type BookState, type OrderbookExtState } from '../../orderbook';
import { formatEntityId } from '../../utils';

// === PURE EVENT TYPES ===
// Events returned by handlers, applied by entity orchestrator

export interface MempoolOp {
  accountId: string;
  tx: AccountTx;
}

export interface SwapOfferEvent {
  offerId: string;
  makerId: string;
  accountId: string;
  giveTokenId: number;
  giveAmount: bigint;
  wantTokenId: number;
  wantAmount: bigint;
  minFillRatio: number;
}

export interface SwapCancelEvent {
  offerId: string;
  accountId: string;
}

export interface MatchResult {
  mempoolOps: MempoolOp[];       // swap_resolve txs to push
  bookUpdates: {                 // orderbook state mutations
    pairId: string;
    book: BookState;
  }[];
}

export interface AccountHandlerResult {
  newState: EntityState;
  outputs: EntityInput[];
  // Pure events for entity-level orchestration:
  mempoolOps: MempoolOp[];
  swapOffersCreated: SwapOfferEvent[];
  swapOffersCancelled: SwapCancelEvent[];
}

export async function handleAccountInput(state: EntityState, input: AccountInput, env: Env): Promise<AccountHandlerResult> {
  console.log(`🚀 APPLY accountInput: ${input.fromEntityId.slice(-4)} → ${input.toEntityId.slice(-4)}`);
  console.log(`🚀 APPLY accountInput details: height=${input.height}, hasNewFrame=${!!input.newAccountFrame}, hasPrevSigs=${!!input.prevSignatures}, counter=${input.counter}`);

  // Create immutable copy of current state
  const newState: EntityState = cloneEntityState(state);
  const outputs: EntityInput[] = [];

  // Collect events for entity-level orchestration (pure - no direct mempool mutation)
  const mempoolOps: MempoolOp[] = [];
  const allSwapOffersCreated: SwapOfferEvent[] = [];
  const allSwapOffersCancelled: SwapCancelEvent[] = [];

  // Get or create account machine (CANONICAL KEY: both entities use same key)
  const canonicalKey = canonicalAccountKey(state.entityId, input.fromEntityId);
  let accountMachine = newState.accounts.get(canonicalKey);
  let isNewAccount = false;

  if (!accountMachine) {
    isNewAccount = true;
    console.log(`💳 Creating new account machine for ${input.fromEntityId.slice(-4)} (canonical key: ${canonicalKey.slice(-20)})`);

    // CONSENSUS FIX: Start with empty deltas (Channel.ts pattern)
    const initialDeltas = new Map();

    // CANONICAL: Sort entities (left < right) like Channel.ts
    const leftEntity = state.entityId < input.fromEntityId ? state.entityId : input.fromEntityId;
    const rightEntity = state.entityId < input.fromEntityId ? input.fromEntityId : state.entityId;

    accountMachine = {
      leftEntity,
      rightEntity,
      mempool: [],
      currentFrame: {
        height: 0,
        timestamp: env.timestamp,
        accountTxs: [],
        prevFrameHash: '',
        tokenIds: [],
        deltas: [],
        stateHash: '',
        byLeft: state.entityId === leftEntity, // Am I left entity?
      },
      sentTransitions: 0,
      ackedTransitions: 0,
      deltas: initialDeltas,
      globalCreditLimits: {
        ownLimit: 0n, // Credit starts at 0 - must be explicitly extended
        peerLimit: 0n, // Credit starts at 0 - must be explicitly extended
      },
      currentHeight: 0,
      pendingSignatures: [],
      rollbackCount: 0,
      sendCounter: 0,    // Channel.ts message counter
      receiveCounter: 0,
      proofHeader: {
        fromEntity: state.entityId,
        toEntity: input.fromEntityId,
        cooperativeNonce: 0,
        disputeNonce: 0,
      },
      proofBody: {
        tokenIds: [],
        deltas: [],
      },
      frameHistory: [],
      pendingWithdrawals: new Map(),
      requestedRebalance: new Map(), // Phase 2: C→R withdrawal tracking
      locks: new Map(), // HTLC: Empty locks map
      swapOffers: new Map(), // Swap: Empty offers map
      // Bilateral J-event consensus
      leftJObservations: [],
      rightJObservations: [],
      jEventChain: [],
      lastFinalizedJHeight: 0,
    };

    // Store with CANONICAL key (already computed above)
    newState.accounts.set(canonicalKey, accountMachine);
    console.log(`✅ Account created with canonical key: ${canonicalKey.slice(-20)}`);
  }

  // FINTECH-SAFETY: Ensure accountMachine exists
  if (!accountMachine) {
    throw new Error(`CRITICAL: AccountMachine creation failed for ${input.fromEntityId}`);
  }

  // NOTE: Credit limits start at 0 - no auto-credit on account opening
  // Credit must be explicitly extended via set_credit_limit transaction

  // CHANNEL.TS PATTERN: Process frame-level consensus ONLY
  if (input.height || input.newAccountFrame) {
    console.log(`🤝 Processing frame from ${input.fromEntityId.slice(-4)}, accountMachine.pendingFrame=${accountMachine.pendingFrame ? `h${accountMachine.pendingFrame.height}` : 'none'}`);

    const result = await processAccountInput(env, accountMachine, input);

    if (result.success) {
      addMessages(newState, result.events);

      // === HTLC LOCK PROCESSING: Check if we need to forward ===
      // CRITICAL: Only process NEW locks (prevent replay on re-processing same frame)
      // Check if this is a NEW frame (just committed) by comparing heights
      const justCommittedFrame = input.newAccountFrame;
      const isNewFrame = Boolean(justCommittedFrame && justCommittedFrame.height > (accountMachine.currentHeight - 1));

      if (isNewFrame && justCommittedFrame?.accountTxs) {
        console.log(`🔍 HTLC-CHECK: isNewFrame=${isNewFrame}, inputHeight=${justCommittedFrame.height}, currentHeight=${accountMachine.currentHeight}`);
        console.log(`🔍 HTLC-CHECK: accountMachine.locks.size=${accountMachine.locks.size}`);
        console.log(`🔍 FRAME-TXS: ${justCommittedFrame.accountTxs.length} txs in frame:`, justCommittedFrame.accountTxs.map(tx => tx.type));
        for (const accountTx of justCommittedFrame.accountTxs) {
          console.log(`🔍 HTLC-CHECK: Checking committed tx type=${accountTx.type}`);

          // === J-EVENT BILATERAL CONSENSUS ===
          if (accountTx.type === 'j_event_claim') {
            const { jHeight, jBlockHash, events, observedAt } = accountTx.data;
            console.log(`📥 j_event_claim: Counterparty claims jHeight=${jHeight}`);

            // Determine which side counterparty is
            const { iAmLeft: weAreLeft, counterparty } = getAccountPerspective(accountMachine, newState.entityId);
            const theyAreLeft = !weAreLeft;

            const obs = { jHeight, jBlockHash, events, observedAt };

            // Store THEIR observation in appropriate array
            if (theyAreLeft) {
              accountMachine.leftJObservations.push(obs);
              console.log(`   📝 Stored LEFT obs from counterparty (${accountMachine.leftJObservations.length} total)`);
            } else {
              accountMachine.rightJObservations.push(obs);
              console.log(`   📝 Stored RIGHT obs from counterparty (${accountMachine.rightJObservations.length} total)`);
            }

            // Try finalize now that we have counterparty's observation
            const { tryFinalizeAccountJEvents } = await import('../j-events');
            tryFinalizeAccountJEvents(accountMachine, counterparty, env);

            continue; // Move to next tx
          }

          if (accountTx.type === 'htlc_lock') {
            console.log(`🔍 HTLC-CHECK: Found htlc_lock in committed frame!`);
            const lock = accountMachine.locks.get(accountTx.data.lockId);
            console.log(`🔍 HTLC-CHECK: lock found? ${!!lock}`);
            if (!lock) {
              console.log(`❌ HTLC-CHECK: Lock not in accountMachine.locks (lockId=${accountTx.data.lockId.slice(0,16)}...)`);
              continue;
            }

            // Check routing info (cleartext for Phase 2)
            const routingInfo = (accountTx.data as any).routingInfo;
            console.log(`🔍 HTLC-ROUTING: routingInfo exists? ${!!routingInfo}`);
            if (routingInfo) {
              console.log(`🔍 HTLC-ROUTING: finalRecipient=${routingInfo.finalRecipient?.slice(-4)}, us=${newState.entityId.slice(-4)}, match=${routingInfo.finalRecipient === newState.entityId}`);
            }
            if (!routingInfo) continue;

            // Are we the final recipient?
            if (routingInfo.finalRecipient === newState.entityId) {
              console.log(`🎯 HTLC-ROUTING: WE ARE FINAL RECIPIENT!`);
              // Final recipient - reveal immediately
              if (routingInfo.secret) {
                mempoolOps.push({
                  accountId: input.fromEntityId,
                  tx: {
                    type: 'htlc_reveal',
                    data: {
                      lockId: lock.lockId,
                      secret: routingInfo.secret
                    }
                  }
                });
                console.log(`🎯 HTLC: Final recipient, revealing secret`);
              }
            } else if (routingInfo.route && routingInfo.route.length > 0) {
              // Intermediary - determine next hop from route
              // routingInfo.route when Hub receives is [hub, bob] - we need to skip ourselves
              // Find our position in route and take the next element
              const ourIndex = routingInfo.route.indexOf(newState.entityId);
              const actualNextHop = ourIndex >= 0 && ourIndex < routingInfo.route.length - 1
                ? routingInfo.route[ourIndex + 1]
                : routingInfo.route[routingInfo.route.length - 1]; // Fallback to last hop

              if (!actualNextHop) {
                console.log(`❌ HTLC: No next hop in route`);
                continue;
              }

              // Register route for backward propagation
              const inboundEntity = newState.entityId === accountMachine.leftEntity ? accountMachine.rightEntity : accountMachine.leftEntity;
              newState.htlcRoutes.set(lock.hashlock, {
                hashlock: lock.hashlock,
                inboundEntity,
                inboundLockId: lock.lockId,
                outboundEntity: actualNextHop,
                outboundLockId: `${lock.lockId}-fwd`,
                createdTimestamp: env.timestamp
              });

              const nextAccount = newState.accounts.get(canonicalAccountKey(state.entityId, actualNextHop));
              if (nextAccount) {
                // Calculate forwarded amounts/timelocks
                const { calculateHtlcFee, calculateHtlcFeeAmount } = await import('../../htlc-utils');
                const forwardAmount = calculateHtlcFee(lock.amount);
                const feeAmount = calculateHtlcFeeAmount(lock.amount);

                // Track fees earned
                newState.htlcFeesEarned += feeAmount;

                // Forward HTLC with reduced timelock/height
                // Update routing info: advance past ourselves in route
                const forwardRoute = ourIndex >= 0
                  ? routingInfo.route?.slice(ourIndex + 1) // Skip ourselves and before
                  : routingInfo.route?.slice(1); // Fallback: just remove first
                const nextNextHop = forwardRoute && forwardRoute.length > 1 ? forwardRoute[1] : null;

                mempoolOps.push({
                  accountId: actualNextHop,
                  tx: {
                    type: 'htlc_lock',
                    data: {
                      lockId: `${lock.lockId}-fwd`,
                      hashlock: lock.hashlock,
                      timelock: lock.timelock - BigInt(10000), // 10s less
                      revealBeforeHeight: lock.revealBeforeHeight - 1,
                      amount: forwardAmount,
                      tokenId: lock.tokenId,
                      routingInfo: {
                        nextHop: nextNextHop,
                        finalRecipient: routingInfo.finalRecipient,
                        route: forwardRoute,
                        secret: routingInfo.secret
                      }
                    }
                  }
                });

                console.log(`➡️ HTLC: Forwarding to ${actualNextHop.slice(-4)}, amount ${forwardAmount} (fee ${feeAmount})`);
              }
            }
          }
        }
      }

      // CRITICAL: Process multi-hop forwarding (consume pendingForward)
      // Skip if env.skipPendingForward (for AHB demo frame separation)
      // AUTO-PROPOSE deferred to Frame 13 when flag cleared
      if (accountMachine.pendingForward && !env.skipPendingForward) {
        const forward = accountMachine.pendingForward;
        const nextHop = forward.route.length > 1 ? forward.route[1] : null;

        if (nextHop) {
          const nextHopAccountKey = canonicalAccountKey(state.entityId, nextHop);
          const nextHopAccount = newState.accounts.get(nextHopAccountKey);
          if (nextHopAccount) {
            // Forward full amount (no fees for simplicity)
            const forwardAmount = forward.amount;

            mempoolOps.push({
              accountId: nextHopAccountKey, // CRITICAL: Use canonical key, not entity ID!
              tx: {
                type: 'direct_payment',
                data: {
                  tokenId: forward.tokenId,
                  amount: forwardAmount,
                  route: forward.route.slice(1),
                  description: forward.description || 'Forwarded payment',
                  fromEntityId: state.entityId,
                  toEntityId: nextHop,
                }
              }
            });

            console.log(`⚡ Multi-hop: Forwarding ${forwardAmount} to ${nextHop.slice(-4)} via account ${nextHopAccountKey.slice(-8)} (no fee)`);
          }
        }

        delete accountMachine.pendingForward;
      }

      // === HTLC SECRET PROPAGATION ===
      // Check if any reveals happened in this frame
      const revealedSecrets = result.revealedSecrets || [];
      console.log(`🔍 HTLC-SECRET-CHECK: ${revealedSecrets.length} secrets revealed in frame`);

      for (const { secret, hashlock } of revealedSecrets) {
        console.log(`🔍 HTLC-SECRET: Processing revealed secret for hash ${hashlock.slice(0,16)}...`);
        const route = newState.htlcRoutes.get(hashlock);
        if (route) {
          // Store secret
          route.secret = secret;

          // Remove from lockBook (E-Machine aggregated view) - payment settled
          if (route.outboundLockId) {
            newState.lockBook.delete(route.outboundLockId);
          }
          if (route.inboundLockId) {
            newState.lockBook.delete(route.inboundLockId);
          }

          // Propagate backward to sender (2024 hashlockMap pattern)
          if (route.inboundEntity && route.inboundLockId) {
            mempoolOps.push({
              accountId: route.inboundEntity,
              tx: {
                type: 'htlc_reveal',
                data: {
                  lockId: route.inboundLockId,
                  secret
                }
              }
            });
            console.log(`⬅️ HTLC: Propagating secret to ${route.inboundEntity.slice(-4)}`);
          } else {
            console.log(`✅ HTLC: Payment complete (we initiated)`);
          }
        } else {
          console.log(`⚠️ HTLC: No route found for hashlock ${hashlock.slice(0,16)}...`);
        }
      }

      // === COLLECT SWAP EVENTS (deferred to entity-level orchestration) ===
      const swapOffersCreated = result.swapOffersCreated || [];
      if (swapOffersCreated.length > 0) {
        console.log(`📊 SWAP-EVENTS: Collected ${swapOffersCreated.length} swap offers for entity-level matching`);
        allSwapOffersCreated.push(...swapOffersCreated);
      }

      const swapOffersCancelled = result.swapOffersCancelled || [];
      if (swapOffersCancelled.length > 0) {
        console.log(`📊 SWAP-EVENTS: Collected ${swapOffersCancelled.length} swap cancels`);
        allSwapOffersCancelled.push(...swapOffersCancelled);
        // Update E-Machine swapBook immediately (this is entity state, not mempool)
        for (const { offerId } of swapOffersCancelled) {
          newState.swapBook.delete(offerId);
        }
      }

      // Send response (ACK + optional new frame)
      if (result.response) {
        console.log(`📤 Sending response to ${result.response.toEntityId.slice(-4)}`);

        // Get target proposer
        let targetProposerId = 'alice';
        const targetReplicaKeys = Array.from(env.eReplicas.keys()).filter(key =>
          key.startsWith(result.response!.toEntityId + ':')
        );

        if (targetReplicaKeys.length > 0) {
          const firstTargetReplica = env.eReplicas.get(targetReplicaKeys[0]!);
          if (firstTargetReplica?.state.config.validators[0]) {
            targetProposerId = firstTargetReplica.state.config.validators[0];
          }
        }

        outputs.push({
          entityId: result.response.toEntityId,
          signerId: targetProposerId,
          entityTxs: [{
            type: 'accountInput',
            data: result.response
          }]
        });

        console.log(`✅ ACK-RESPONSE queued: ${state.entityId.slice(-4)} → ${result.response.toEntityId.slice(-4)}, height=${result.response.height}, hasPrevSigs=${!!result.response.prevSignatures}, counter=${result.response.counter}`);
      }
    } else {
      console.error(`❌ Frame consensus failed: ${result.error}`);
      addMessage(newState, `❌ ${result.error}`);
    }
  } else {
    // NO individual accountTx handling! Channel.ts sends frames ONLY
    console.error(`❌ Received AccountInput without frames - invalid!`);
    addMessage(newState, `❌ Invalid AccountInput from ${input.fromEntityId.slice(-4)}`);
  }

  return {
    newState,
    outputs,
    mempoolOps,
    swapOffersCreated: allSwapOffersCreated,
    swapOffersCancelled: allSwapOffersCancelled
  };
}

/**
 * Process swap offers through hub's orderbook (PURE - returns events, no mutations)
 * Called at entity level after aggregating all swap events
 */
export function processOrderbookSwaps(
  hubState: EntityState,
  swapOffers: SwapOfferEvent[]
): MatchResult {
  const mempoolOps: MempoolOp[] = [];
  const bookUpdates: { pairId: string; book: BookState }[] = [];
  const ext = hubState.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return { mempoolOps, bookUpdates };

  for (const offer of swapOffers) {
    const { pairId } = canonicalPair(offer.giveTokenId, offer.wantTokenId);
    const bookKey = pairId;

    const side = deriveSide(offer.giveTokenId, offer.wantTokenId);
    const LOT_SCALE = 10n ** 12n;
    const MAX_LOTS = 0xFFFFFFFFn;

    let priceTicks: bigint;
    let qtyLots: bigint;

    if (side === 1) {
      priceTicks = (offer.wantAmount * 100n) / offer.giveAmount;
      qtyLots = offer.giveAmount / LOT_SCALE;
    } else {
      priceTicks = (offer.giveAmount * 100n) / offer.wantAmount;
      qtyLots = offer.wantAmount / LOT_SCALE;
    }

    if (qtyLots === 0n || qtyLots > MAX_LOTS || priceTicks <= 0n || priceTicks > MAX_LOTS) {
      console.warn(`📊 ORDERBOOK REJECT: Invalid order, offerId=${offer.offerId}`);
      continue;
    }

    let book = ext.books.get(bookKey);
    if (!book) {
      const BOOK_LEVELS = 100;
      const PRICE_TICK = 1000;
      const center = Number(priceTicks);
      const halfRange = PRICE_TICK * Math.floor(BOOK_LEVELS / 2);
      const pmin = Math.max(1, center - halfRange);
      const pmax = pmin + PRICE_TICK * (BOOK_LEVELS - 1);

      book = createBook({
        tick: PRICE_TICK,
        pmin,
        pmax,
        maxOrders: 10000,
        stpPolicy: 0,
      });
    }

    const namespacedOrderId = `${offer.accountId}:${offer.offerId}`;
    console.log(`📊 ORDERBOOK ADD: maker=${formatEntityId(offer.makerId)}, orderId=${namespacedOrderId.slice(-20)}, side=${side}, price=${priceTicks}, qty=${qtyLots}`);

    const result = applyCommand(book, {
      kind: 0,
      ownerId: offer.makerId,
      orderId: namespacedOrderId,
      side,
      tif: 0,
      postOnly: false,
      priceTicks: Number(priceTicks),
      qtyLots: Number(qtyLots),
      minFillRatio: offer.minFillRatio ?? 0,
    });

    book = result.state;
    bookUpdates.push({ pairId: bookKey, book });

    // Process trade events
    const fillsPerOrder = new Map<string, { filledLots: number; originalLots: number }>();

    for (const event of result.events) {
      if (event.type === 'TRADE') {
        const extractOfferId = (namespacedId: string) => {
          const lastColon = namespacedId.lastIndexOf(':');
          return lastColon >= 0 ? namespacedId.slice(lastColon + 1) : namespacedId;
        };

        const makerEntry = fillsPerOrder.get(event.makerOrderId);
        if (!makerEntry) {
          fillsPerOrder.set(event.makerOrderId, { filledLots: event.qty, originalLots: event.makerQtyBefore });
        } else {
          makerEntry.filledLots += event.qty;
        }

        const takerEntry = fillsPerOrder.get(event.takerOrderId);
        if (!takerEntry) {
          fillsPerOrder.set(event.takerOrderId, { filledLots: event.qty, originalLots: event.takerQtyTotal });
        } else {
          takerEntry.filledLots += event.qty;
        }

        console.log(`📊 ORDERBOOK TRADE: ${extractOfferId(event.makerOrderId)} ↔ ${extractOfferId(event.takerOrderId)} @ ${event.price}, qty=${event.qty}`);
      }
    }

    // Emit swap_resolve for each filled order
    const MAX_FILL_RATIO = 65535;

    for (const [namespacedOrderId, { filledLots, originalLots }] of fillsPerOrder) {
      const lastColon = namespacedOrderId.lastIndexOf(':');
      if (lastColon === -1) continue;
      const offerId = namespacedOrderId.slice(lastColon + 1);
      const accountIdPart = namespacedOrderId.slice(0, lastColon);

      const colonIdx = accountIdPart.indexOf(':', 2);
      if (colonIdx === -1) continue;
      const fromEntity = accountIdPart.slice(0, colonIdx);
      const toEntity = accountIdPart.slice(colonIdx + 1);

      // Determine which account to push to
      const accountId = hubState.accounts.has(fromEntity) ? fromEntity : toEntity;

      const filledBig = BigInt(filledLots);
      const originalBig = BigInt(originalLots);
      const fillRatio = originalBig > 0n
        ? Number((filledBig * BigInt(MAX_FILL_RATIO)) / originalBig)
        : 0;

      const orderStillInBook = book.orderIdToIdx.has(namespacedOrderId) &&
        book.orderActive[book.orderIdToIdx.get(namespacedOrderId)!];

      mempoolOps.push({
        accountId,
        tx: {
          type: 'swap_resolve',
          data: {
            offerId,
            fillRatio: Math.min(fillRatio, MAX_FILL_RATIO),
            cancelRemainder: !orderStillInBook,
          }
        }
      });
      console.log(`📤 ORDERBOOK: Queued swap_resolve for ${offerId.slice(-8)}, fill=${(fillRatio/MAX_FILL_RATIO*100).toFixed(1)}%, cancel=${!orderStillInBook}`);
    }
  }

  return { mempoolOps, bookUpdates };
}

/**
 * Process swap cancels through hub's orderbook
 */
export function processOrderbookCancels(
  hubState: EntityState,
  cancels: SwapCancelEvent[]
): { pairId: string; book: BookState }[] {
  const bookUpdates: { pairId: string; book: BookState }[] = [];
  const ext = hubState.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return bookUpdates;

  for (const { offerId, accountId } of cancels) {
    const namespacedOrderId = `${accountId}:${offerId}`;

    for (const [bookKey, book] of ext.books) {
      const orderIdx = book.orderIdToIdx.get(namespacedOrderId);
      if (orderIdx !== undefined && book.orderActive[orderIdx]) {
        const ownerId = book.owners[book.orderOwnerIdx[orderIdx]];

        const result = applyCommand(book, {
          kind: 1,
          ownerId,
          orderId: namespacedOrderId,
          side: 0,
          tif: 0,
          postOnly: false,
          priceTicks: 0,
          qtyLots: 0,
        });

        bookUpdates.push({ pairId: bookKey, book: result.state });
        console.log(`📊 ORDERBOOK: Cancelled order ${offerId.slice(-8)}`);
        break;
      }
    }
  }

  return bookUpdates;
}

