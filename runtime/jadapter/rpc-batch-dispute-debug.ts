import { hashDisputeProofHankoPayload } from '../hanko/onchain-domain';
import type { JBatch } from '../jurisdiction/batch';
import { computeAccountKey } from './helpers';

type DisputeDebugDomain = {
  chainId: number;
  depositoryAddress: string;
};

export const buildDisputeStartDebug = async (
  batch: JBatch,
  senderEntityId: string,
  domain: DisputeDebugDomain,
): Promise<Array<Record<string, unknown>>> => {
  if (batch.disputeStarts.length === 0) return [];
  const { inspectHankoForHash } = await import('../hanko/signing');
  return Promise.all(
    batch.disputeStarts.map(async start => {
      const accountKey = computeAccountKey(senderEntityId, start.counterentity);
      const disputeHash = hashDisputeProofHankoPayload(
        domain,
        accountKey,
        start.nonce,
        start.proofbodyHash,
        start.watchSeed,
      );
      const hanko = await inspectHankoForHash(start.sig, disputeHash);
      const claim = hanko.claims.find(
        item => String(item.entityId).toLowerCase() === String(start.counterentity).toLowerCase(),
      );
      return {
        contractGuard: 'EntityProvider.sol:469 require(entityId == boardHash)',
        senderEntityId,
        counterentity: start.counterentity,
        nonce: start.nonce,
        proofbodyHash: start.proofbodyHash,
        starterInitialArgumentsBytes: Math.max(start.starterInitialArguments.length - 2, 0) / 2,
        starterIncrementedArgumentsBytes: Math.max(start.starterIncrementedArguments.length - 2, 0) / 2,
        disputeHash,
        accountKey,
        sigBytes: Math.max(start.sig.length - 2, 0) / 2,
        recoveredAddresses: hanko.recoveredAddresses,
        matchingClaim: claim
          ? {
              entityId: claim.entityId,
              threshold: claim.threshold,
              entityIndexes: claim.entityIndexes,
              weights: claim.weights,
              boardEntityIds: claim.boardEntityIds,
              reconstructedBoardHash: claim.reconstructedBoardHash,
              entityMatchesBoardHash:
                String(claim.entityId).toLowerCase() === String(claim.reconstructedBoardHash).toLowerCase(),
            }
          : null,
      };
    }),
  );
};
