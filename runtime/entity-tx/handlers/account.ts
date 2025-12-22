import { AccountInput, AccountTx, EntityState, Env, EntityInput, EntityTx } from '../../types';
import { handleAccountInput as processAccountInput } from '../../account-consensus';
import { cloneEntityState, addMessage, addMessages } from '../../state-helpers';

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
      const isNewFrame = justCommittedFrame && justCommittedFrame.height > (accountMachine.currentHeight - 1);

      console.log(`🔍 HTLC-CHECK: isNewFrame=${isNewFrame}, inputHeight=${justCommittedFrame?.height}, currentHeight=${accountMachine.currentHeight}`);
      console.log(`🔍 HTLC-CHECK: accountMachine.locks.size=${accountMachine.locks.size}`);

      if (isNewFrame && justCommittedFrame.accountTxs) {
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
              // routingInfo.route is from sender's perspective: [hub, bob] when Hub receives
              const actualNextHop = routingInfo.route[0]; // First in remaining route = our next hop

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
                // Update routing info: advance to next hop in route
                const forwardRoute = routingInfo.route?.slice(1); // Remove current hop
                const nextNextHop = forwardRoute && forwardRoute.length > 0 ? forwardRoute[0] : null;

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
