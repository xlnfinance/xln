import { AccountInput, AccountTx, EntityState, Env, EntityInput } from '../../types';
import { handleAccountInput as processAccountInput } from '../../account-consensus';
import { cloneEntityState } from '../../state-helpers';
import { getDefaultCreditLimit } from '../../account-utils';

export async function handleAccountInput(state: EntityState, input: AccountInput, env: Env): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  console.log(`🚀 APPLY accountInput: ${input.fromEntityId.slice(-4)} → ${input.toEntityId.slice(-4)}`);

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
        frameId: 0,
        timestamp: Date.now(),
        tokenIds: [],
        deltas: [],
      },
      sentTransitions: 0,
      ackedTransitions: 0,
      deltas: initialDeltas,
      globalCreditLimits: {
        ownLimit: getDefaultCreditLimit(2),
        peerLimit: getDefaultCreditLimit(2),
      },
      currentFrameId: 0,
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
      frameHistory: []
    };

    newState.accounts.set(input.fromEntityId, accountMachine);
  }

  // FINTECH-SAFETY: Ensure accountMachine exists
  if (!accountMachine) {
    throw new Error(`CRITICAL: AccountMachine creation failed for ${input.fromEntityId}`);
  }

  // Auto-queue our credit limit when we receive opening frame from new account
  // Frame #1 from opener contains: [add_delta, set_credit_limit(their_side)]
  // We respond with frame #2: [set_credit_limit(our_side)] batched with ACK
  if (isNewAccount && input.newAccountFrame) {
    const hasAddDelta = input.newAccountFrame.accountTxs.some(tx => tx.type === 'add_delta');

    if (hasAddDelta) {
      const usdcTokenId = 1;
      const defaultCreditLimit = getDefaultCreditLimit(1); // 1M USDC (token 1)

      console.log(`💳 NEW-ACCOUNT: Received opening frame, queueing our credit limit`);

      // Determine canonical side - DETERMINISTIC
      const isLeftEntity = state.entityId < input.fromEntityId;
      const ourSide: 'left' | 'right' = isLeftEntity ? 'left' : 'right';

      // Queue our credit limit - will be sent with ACK (Channel.ts pattern)
      accountMachine.mempool.push({
        type: 'set_credit_limit',
        data: { tokenId: usdcTokenId, amount: defaultCreditLimit, side: ourSide }
      });

      console.log(`📝 Queued set_credit_limit(side=${ourSide}, 1M) - will batch with ACK`);
    }
  }

  // CHANNEL.TS PATTERN: Process frame-level consensus ONLY
  if (input.frameId || input.newAccountFrame) {
    console.log(`🤝 Processing frame from ${input.fromEntityId.slice(-4)}`);

    const result = await processAccountInput(accountMachine, input);

    if (result.success) {
      newState.messages.push(...result.events);

      // CRITICAL: Process multi-hop forwarding (consume pendingForward)
      if (accountMachine.pendingForward) {
        const forward = accountMachine.pendingForward;
        console.log(`🔀 MULTI-HOP: Payment needs forwarding to ${forward.route[forward.route.length - 1]?.slice(-4)}`);

        // Next hop is first entity in remaining route
        const nextHop = forward.route[0];
        if (nextHop) {
          // Calculate forwarding fee (0.1% minimum 1 token)
          const feeRate = 1000n; // 0.1% = 1/1000
          const fee = forward.amount / feeRate > 1n ? forward.amount / feeRate : 1n;
          const forwardAmount = forward.amount - fee;

          console.log(`💰 Forwarding fee: ${fee}, forward amount: ${forwardAmount}`);

          // Check if we have account with next hop
          const nextHopAccount = newState.accounts.get(nextHop);
          if (nextHopAccount) {
            // Create forwarding payment transaction
            const forwardingTx: AccountTx = {
              type: 'direct_payment',
              data: {
                tokenId: forward.tokenId,
                amount: forwardAmount,
                route: forward.route.slice(1), // Remove current hop from route
                ...(forward.description ? { description: forward.description } : {}),
                fromEntityId: state.entityId,
                toEntityId: nextHop,
              }
            };

            // Add to next hop's account mempool
            nextHopAccount.mempool.push(forwardingTx);
            console.log(`✅ Forwarded payment added to account ${nextHop.slice(-4)} mempool`);

            newState.messages.push(`⚡ Relayed payment to Entity ${nextHop.slice(-4)}`);
          } else {
            console.error(`❌ No account with next hop ${nextHop.slice(-4)} for forwarding`);
            newState.messages.push(`❌ Payment routing failed: no account with next hop`);
          }
        }

        // Clear pendingForward
        delete accountMachine.pendingForward;
      }

      // Send response (ACK + optional new frame)
      if (result.response) {
        console.log(`📤 Sending response to ${result.response.toEntityId.slice(-4)}`);

        // Get target proposer
        let targetProposerId = 'alice';
        const targetReplicaKeys = Array.from(env.replicas.keys()).filter(key =>
          key.startsWith(result.response!.toEntityId + ':')
        );

        if (targetReplicaKeys.length > 0) {
          const firstTargetReplica = env.replicas.get(targetReplicaKeys[0]!);
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

        console.log(`✅ Response queued`);
      }
    } else {
      console.error(`❌ Frame consensus failed: ${result.error}`);
      newState.messages.push(`❌ ${result.error}`);
    }
  } else {
    // NO individual accountTx handling! Channel.ts sends frames ONLY
    console.error(`❌ Received AccountInput without frames - invalid!`);
    newState.messages.push(`❌ Invalid AccountInput from ${input.fromEntityId.slice(-4)}`);
  }

  return { newState, outputs };
}
