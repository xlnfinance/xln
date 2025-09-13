import { EntityState, ProposalAction, Proposal } from '../types.js';
import { addToReserves, subtractFromReserves } from './financial.js';
import { generateProposalId } from './proposals.js';
import { DEBUG } from '../utils.js';

export const handleJEvent = (entityState: EntityState, entityTxData: any): EntityState => {
  const { from, event, observedAt, blockNumber, transactionHash } = entityTxData;

  if (DEBUG) {
    console.log(`    🔭 J-EVENT: ${from} observed ${event.type} at block ${blockNumber}`);
    console.log(`    🔭 J-EVENT-DATA:`, entityTxData);
  }

  const isSingleSig = entityState.config.mode === 'proposer-based' && entityState.config.threshold === 1n;

  if (isSingleSig) {
    const newEntityState = {
      ...entityState,
      messages: [...entityState.messages],
      nonces: new Map(entityState.nonces),
      proposals: new Map(entityState.proposals),
      reserves: new Map(entityState.reserves),
      channels: new Map(entityState.channels),
      collaterals: new Map(entityState.collaterals),
    };

    newEntityState.messages.push(
      `${from} observed j-event: ${event.type} (block ${blockNumber}, tx ${transactionHash.slice(0, 10)}...)`,
    );

    const replica = { entityId: from } as any;

    switch (event.type) {
      case 'reserveToReserve': {
        const { from, to, asset, amount, decimals } = event.data;

        if (!to || from === to) {
          if (replica.entityId === from) {
            addToReserves(newEntityState.reserves, asset, BigInt(amount), decimals || 18);
          }
        } else {
          if (replica.entityId === from) {
            subtractFromReserves(newEntityState.reserves, asset, BigInt(amount));
          } else if (replica.entityId === to) {
            addToReserves(newEntityState.reserves, asset, BigInt(amount), decimals || 18);
          }
        }
        break;
      }

      case 'TransferReserveToCollateral':
        subtractFromReserves(newEntityState.reserves, `token-${event.data.tokenId}`, BigInt(event.data.amount));
        addToReserves(newEntityState.collaterals, `token-${event.data.tokenId}`, BigInt(event.data.collateral), 18);
        break;

      case 'DisputeStarted': {
        const peer = event.data.peer;
        const channelKey = peer;

        const existingChannel = newEntityState.channels.get(channelKey) || {
          counterparty: peer,
          myBalance: 0n,
          theirBalance: 0n,
          collateral: [],
          nonce: 0,
          isActive: true,
          lastUpdate: observedAt,
        };

        newEntityState.messages.push(`⚡ Dispute started with ${peer} (nonce=${event.data.disputeNonce})`);
        break;
      }

      case 'CooperativeClose':
        newEntityState.channels.delete(event.data.peer);
        break;

      case 'ControlSharesReceived':
        addToReserves(newEntityState.reserves, event.data.tokenId, BigInt(event.data.amount), event.data.decimals || 0);
        break;

      case 'ControlSharesTransferred':
        subtractFromReserves(newEntityState.reserves, `share-${event.data.internalTokenId}`, BigInt(event.data.amount));
        addToReserves(newEntityState.reserves, `share-${event.data.internalTokenId}`, BigInt(event.data.amount), 0);
        break;

      case 'GovernanceEnabled':
        addToReserves(newEntityState.reserves, `control-${event.data.controlTokenId}`, BigInt(1e15), 0);
        addToReserves(newEntityState.reserves, `dividend-${event.data.dividendTokenId}`, BigInt(1e15), 0);
        break;

      case 'ControlSharesReleased':
        subtractFromReserves(
          newEntityState.reserves,
          `control-${event.data.entityId}`,
          BigInt(event.data.controlAmount),
        );
        subtractFromReserves(
          newEntityState.reserves,
          `dividend-${event.data.entityId}`,
          BigInt(event.data.dividendAmount),
        );
        break;

      default:
        newEntityState.messages.push(`⚠️ Unhandled j-event type: ${event.type}`);
    }

    return newEntityState;
  } else {
    // Multi-sig: wrap as proposal
    const action: ProposalAction = {
      type: 'collective_message',
      data: {
        message: `${from} proposed j-event: ${event.type} (block ${blockNumber}, tx ${transactionHash.slice(0, 10)}...)`,
      },
    };
    const proposalId = generateProposalId(action, from, entityState);
    const proposal: Proposal = {
      id: proposalId,
      proposer: from,
      action,
      votes: new Map([[from, 'yes']]),
      status: 'pending',
      created: observedAt,
    };

    const newProposals = new Map(entityState.proposals);
    newProposals.set(proposalId, proposal);

    return {
      ...entityState,
      proposals: newProposals,
      messages: [...entityState.messages, `${from} proposed j-event: ${event.type}`],
    };
  }
};
