import { AccountInput, AccountTx, EntityState, Env, EntityInput, EntityTx } from '../../types';
import { handleAccountInput as processAccountInput } from '../../account-consensus';
import { cloneEntityState, addMessage, addMessages } from '../../state-helpers';
import { applyCommand, createBook, canonicalPair, deriveSide, type BookState, type OrderbookExtState } from '../../orderbook';
import { formatEntityId } from '../../utils';

export async function handleAccountInput(state: EntityState, input: AccountInput, env: Env): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  console.log(`🚀 APPLY accountInput: ${input.fromEntityId.slice(-4)} → ${input.toEntityId.slice(-4)}`);
  console.log(`🚀 APPLY accountInput details: height=${input.height}, hasNewFrame=${!!input.newAccountFrame}, hasPrevSigs=${!!input.prevSignatures}, counter=${input.counter}`);

  // Create immutable copy of current state
  const newState: EntityState = cloneEntityState(state);
  const outputs: EntityInput[] = [];

  // Get or create account machine for this counterparty
  let accountMachine = newState.accounts.get(input.fromEntityId);
  let isNewAccount = false;

  if (!accountMachine) {
    isNewAccount = true;
    console.log(`💳 Creating new account machine for ${input.fromEntityId.slice(-4)}`);

    // CONSENSUS FIX: Start with empty deltas (Channel.ts pattern)
    const initialDeltas = new Map();

    accountMachine = {
      counterpartyEntityId: input.fromEntityId,
      mempool: [],
      currentFrame: {
        height: 0,
        timestamp: env.timestamp,
        accountTxs: [],
        prevFrameHash: '',
        tokenIds: [],
        deltas: [],
        stateHash: '',
        byLeft: state.entityId < input.fromEntityId, // Determine perspective
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
    };

    newState.accounts.set(input.fromEntityId, accountMachine);
  }

  // FINTECH-SAFETY: Ensure accountMachine exists
  if (!accountMachine) {
    throw new Error(`CRITICAL: AccountMachine creation failed for ${input.fromEntityId}`);
  }

  // NOTE: Credit limits start at 0 - no auto-credit on account opening
  // Credit must be explicitly extended via set_credit_limit transaction

  // CHANNEL.TS PATTERN: Process frame-level consensus ONLY
  if (input.height || input.newAccountFrame) {
    console.log(`🤝 Processing frame from ${input.fromEntityId.slice(-4)}`);

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
        for (const accountTx of justCommittedFrame.accountTxs) {
          console.log(`🔍 HTLC-CHECK: Checking committed tx type=${accountTx.type}`);
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
                accountMachine.mempool.push({
                  type: 'htlc_reveal',
                  data: {
                    lockId: lock.lockId,
                    secret: routingInfo.secret
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
              newState.htlcRoutes.set(lock.hashlock, {
                hashlock: lock.hashlock,
                inboundEntity: accountMachine.counterpartyEntityId,
                inboundLockId: lock.lockId,
                outboundEntity: actualNextHop,
                outboundLockId: `${lock.lockId}-fwd`,
                createdTimestamp: env.timestamp
              });

              const nextAccount = newState.accounts.get(actualNextHop);
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

                nextAccount.mempool.push({
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
          const nextHopAccount = newState.accounts.get(nextHop);
          if (nextHopAccount) {
            // Forward full amount (no fees for simplicity)
            const forwardAmount = forward.amount;

            nextHopAccount.mempool.push({
              type: 'direct_payment',
              data: {
                tokenId: forward.tokenId,
                amount: forwardAmount,
                route: forward.route.slice(1),
                description: forward.description || 'Forwarded payment',
                fromEntityId: state.entityId,
                toEntityId: nextHop,
              }
            });

            console.log(`⚡ Multi-hop: Forwarding ${forwardAmount} to ${nextHop.slice(-4)} (no fee)`);
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
            const senderAccount = newState.accounts.get(route.inboundEntity);
            if (senderAccount) {
              senderAccount.mempool.push({
                type: 'htlc_reveal',
                data: {
                  lockId: route.inboundLockId,
                  secret
                }
              });
              console.log(`⬅️ HTLC: Propagating secret to ${route.inboundEntity.slice(-4)}`);
            }
          } else {
            console.log(`✅ HTLC: Payment complete (we initiated)`);
          }
        } else {
          console.log(`⚠️ HTLC: No route found for hashlock ${hashlock.slice(0,16)}...`);
        }
      }

      // === ORDERBOOK SWAP MATCHING ===
      // Process swap offers through hub's orderbook extension
      const swapOffersCreated = result.swapOffersCreated || [];
      if (swapOffersCreated.length > 0) {
        console.log(`📊 ORDERBOOK-CHECK: ${swapOffersCreated.length} swap offers, hasExt=${!!newState.orderbookExt}`);
        if (newState.orderbookExt) {
          console.log(`📊 ORDERBOOK: Processing ${swapOffersCreated.length} swap offers`);
          const orderbookOutputs = await processOrderbookSwaps(env, newState, swapOffersCreated);
          console.log(`📊 ORDERBOOK: Generated ${orderbookOutputs.length} outputs`);
          outputs.push(...orderbookOutputs);
        }
      }

      // === ORDERBOOK CLEANUP ===
      // Remove cancelled/filled orders from orderbook
      const swapOffersCancelled = result.swapOffersCancelled || [];
      if (swapOffersCancelled.length > 0) {
        // Update E-Machine swapBook
        for (const { offerId } of swapOffersCancelled) {
          newState.swapBook.delete(offerId);
        }
        // Update hub orderbook extension if present
        if (newState.orderbookExt) {
          console.log(`📊 ORDERBOOK-CLEANUP: Removing ${swapOffersCancelled.length} cancelled orders`);
          processOrderbookCancels(newState, swapOffersCancelled);
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

  return { newState, outputs };
}

/**
 * Process swap offers through hub's orderbook
 * Returns EntityInputs containing swap_resolve transactions
 */
async function processOrderbookSwaps(
  env: Env,
  hubState: EntityState,
  swapOffers: Array<{
    offerId: string;
    makerId: string;
    accountId: string;
    giveTokenId: number;
    giveAmount: bigint;
    wantTokenId: number;
    wantAmount: bigint;
    minFillRatio: number;
  }>
): Promise<EntityInput[]> {
  const outputs: EntityInput[] = [];
  const ext = hubState.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return outputs;

  for (const offer of swapOffers) {
    const { pairId } = canonicalPair(offer.giveTokenId, offer.wantTokenId);
    const bookKey = pairId;  // Later: `${jId}/${pairId}` for cross-J

    // Convert swap offer to orderbook command
    const side = deriveSide(offer.giveTokenId, offer.wantTokenId);
    const LOT_SCALE = 10n ** 12n;  // 10^12-scale lots (max ~4294 ETH per order)
    const MAX_LOTS = 0xFFFFFFFFn;  // Uint32 max

    let priceTicks: bigint;
    let qtyLots: bigint;

    if (side === 1) {  // SELL base
      priceTicks = (offer.wantAmount * 100n) / offer.giveAmount;
      qtyLots = offer.giveAmount / LOT_SCALE;
    } else {  // BUY base
      priceTicks = (offer.giveAmount * 100n) / offer.wantAmount;
      qtyLots = offer.wantAmount / LOT_SCALE;
    }

    // Validate: reject orders that would overflow Uint32 or be zero
    if (qtyLots === 0n) {
      console.warn(`📊 ORDERBOOK REJECT: Order too small (qty rounds to 0 lots), offerId=${offer.offerId}`);
      continue;
    }
    if (qtyLots > MAX_LOTS) {
      console.warn(`📊 ORDERBOOK REJECT: Order too large (${qtyLots} > ${MAX_LOTS} lots), offerId=${offer.offerId}`);
      continue;
    }
    if (priceTicks <= 0n || priceTicks > MAX_LOTS) {
      console.warn(`📊 ORDERBOOK REJECT: Invalid price ticks (${priceTicks}), offerId=${offer.offerId}`);
      continue;
    }

    // Get or create book for this pair (minimal grid for faster snapshots)
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

    // QUANTIZATION FIX: Store quantized amounts in offer for consistent settlement
    // This ensures fill ratios from lots match exactly with settlement amounts
    // quantizedGive = qtyLots * LOT_SCALE (rounds down to lot boundary)
    // quantizedWant = proportionally scaled to maintain price ratio
    const quantizedGive = qtyLots * LOT_SCALE;
    const quantizedWant = offer.giveAmount > 0n
      ? (quantizedGive * offer.wantAmount) / offer.giveAmount
      : 0n;
    offer.quantizedGive = quantizedGive;
    offer.quantizedWant = quantizedWant;

    // Namespace orderId by accountId to prevent cross-account collisions
    const namespacedOrderId = `${offer.accountId}:${offer.offerId}`;
    console.log(`📊 ORDERBOOK ADD: maker=${formatEntityId(offer.makerId)}, orderId=${namespacedOrderId.slice(-20)}, side=${side}, price=${priceTicks}, qty=${qtyLots}`);

    // Apply order to book (convert BigInt to Number only after validation)
    // Pass minFillRatio to orderbook for pre-flight simulation
    const result = applyCommand(book, {
      kind: 0,
      ownerId: offer.makerId,
      orderId: namespacedOrderId,
      side,
      tif: 0,  // GTC
      postOnly: false,
      priceTicks: Number(priceTicks),
      qtyLots: Number(qtyLots),
      minFillRatio: offer.minFillRatio ?? 0,
    });

    book = result.state;
    ext.books.set(bookKey, book);

    // Process trade events → emit swap_resolve transactions
    // Track cumulative fills per order in LOTS (orderbook units)
    // We'll convert back to wei using LOT_SCALE when computing fillRatio
    const fillsPerOrder = new Map<string, { filledLots: number; originalLots: number }>();

    for (const event of result.events) {
      if (event.type === 'TRADE') {
        const extractOfferId = (namespacedId: string) => {
          const lastColon = namespacedId.lastIndexOf(':');
          return lastColon >= 0 ? namespacedId.slice(lastColon + 1) : namespacedId;
        };
        const makerOfferId = extractOfferId(event.makerOrderId);
        const takerOfferId = extractOfferId(event.takerOrderId);

        // Accumulate fills in lots
        // makerQtyBefore: maker's qty BEFORE this trade (i.e., what's on the book before matching)
        // First trade for a maker captures the full order size via makerQtyBefore
        const makerEntry = fillsPerOrder.get(event.makerOrderId);
        if (!makerEntry) {
          // First trade: originalLots = makerQtyBefore (the full order size before any fills)
          fillsPerOrder.set(event.makerOrderId, { filledLots: event.qty, originalLots: event.makerQtyBefore });
        } else {
          makerEntry.filledLots += event.qty;
          fillsPerOrder.set(event.makerOrderId, makerEntry);
        }

        // Taker: use takerQtyTotal as the original order size
        const takerEntry = fillsPerOrder.get(event.takerOrderId);
        if (!takerEntry) {
          fillsPerOrder.set(event.takerOrderId, { filledLots: event.qty, originalLots: event.takerQtyTotal });
        } else {
          takerEntry.filledLots += event.qty;
          fillsPerOrder.set(event.takerOrderId, takerEntry);
        }

        console.log(`📊 ORDERBOOK TRADE: ${makerOfferId} ↔ ${takerOfferId} @ ${event.price}, qty=${event.qty}`);
        console.log(`   maker=${formatEntityId(event.makerOwnerId)} (had ${event.makerQtyBefore}), taker=${formatEntityId(event.takerOwnerId)} (order ${event.takerQtyTotal})`);
      }
    }

    // Emit swap_resolve for each filled order with correct fill ratio
    const MAX_FILL_RATIO = 65535;

    for (const [namespacedOrderId, { filledLots, originalLots }] of fillsPerOrder) {
      // namespacedOrderId format: "fromEntity:toEntity:offerId"
      const lastColon = namespacedOrderId.lastIndexOf(':');
      if (lastColon === -1) {
        console.warn(`📊 ORDERBOOK: Invalid order ID format: ${namespacedOrderId}`);
        continue;
      }
      const offerId = namespacedOrderId.slice(lastColon + 1);
      const accountIdPart = namespacedOrderId.slice(0, lastColon);

      // Split accountId to get both entity IDs
      const colonIdx = accountIdPart.indexOf(':', 2);
      if (colonIdx === -1) {
        console.warn(`📊 ORDERBOOK: Invalid accountId format: ${accountIdPart}`);
        continue;
      }
      const fromEntity = accountIdPart.slice(0, colonIdx);
      const toEntity = accountIdPart.slice(colonIdx + 1);

      // Find the account - hub's accounts are keyed by counterparty ID
      let account = hubState.accounts.get(fromEntity);
      if (!account) {
        account = hubState.accounts.get(toEntity);
      }

      if (!account) {
        console.warn(`📊 ORDERBOOK: No account found for order ${offerId}, tried ${fromEntity.slice(-8)} and ${toEntity.slice(-8)}`);
        continue;
      }

      // Calculate fill ratio using BigInt math to avoid precision loss
      // fillRatio = (filledLots / originalLots) * MAX_FILL_RATIO
      const filledBig = BigInt(filledLots);
      const originalBig = BigInt(originalLots);
      const fillRatio = originalBig > 0n
        ? Number((filledBig * BigInt(MAX_FILL_RATIO)) / originalBig)
        : 0;

      // Determine if order is fully filled (no remainder in book)
      const orderStillInBook = book.orderIdToIdx.has(namespacedOrderId) &&
        book.orderActive[book.orderIdToIdx.get(namespacedOrderId)!];

      account.mempool.push({
        type: 'swap_resolve',
        data: {
          offerId,
          fillRatio: Math.min(fillRatio, MAX_FILL_RATIO),
          cancelRemainder: !orderStillInBook,
        }
      });
      console.log(`📤 ORDERBOOK: Queued swap_resolve for ${offerId.slice(-8)}, fill=${(fillRatio/MAX_FILL_RATIO*100).toFixed(1)}%, cancel=${!orderStillInBook}`);
    }
  }

  return outputs;
}

/** Find the account ID for an entity (hub perspective) */
function findAccountId(hubState: EntityState, entityId: string): string | null {
  for (const [counterpartyId, _] of hubState.accounts) {
    if (counterpartyId === entityId) {
      return counterpartyId;
    }
  }
  return null;
}

/**
 * Remove cancelled/filled orders from hub's orderbook
 * Called after swap_cancel or swap_resolve with cancelRemainder=true
 */
function processOrderbookCancels(
  hubState: EntityState,
  cancels: Array<{ offerId: string; accountId: string }>
): void {
  const ext = hubState.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return;

  for (const { offerId, accountId } of cancels) {
    // The orderId in the book is namespaced as accountId:offerId
    const namespacedOrderId = `${accountId}:${offerId}`;

    // Find which book this order is in and cancel it
    for (const [bookKey, book] of ext.books) {
      const orderIdx = book.orderIdToIdx.get(namespacedOrderId);
      if (orderIdx !== undefined && book.orderActive[orderIdx]) {
        // Get the order's owner to pass for cancel validation
        const ownerId = book.owners[book.orderOwnerIdx[orderIdx]];

        const result = applyCommand(book, {
          kind: 1, // CANCEL
          ownerId,
          orderId: namespacedOrderId,
        });

        if (result.events.some(e => e.type === 'CANCELED')) {
          ext.books.set(bookKey, result.state);
          console.log(`📊 ORDERBOOK-CLEANUP: Removed ${offerId.slice(-8)} from book ${bookKey}`);
        }
        break; // Order only exists in one book
      }
    }
  }
}
