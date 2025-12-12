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
        stateHash: ''
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

      // CRITICAL: Process multi-hop forwarding (consume pendingForward)
      // Skip if env.skipPendingForward is set (for discrete frame separation in demos)
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
