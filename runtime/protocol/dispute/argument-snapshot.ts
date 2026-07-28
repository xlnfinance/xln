import type { ProofBodyStruct } from '../../../jurisdictions/typechain-types/contracts/Depository.sol/Depository';
import { cloneProofBodyStruct } from './proof-body';

export type DisputeArgumentSide = 'left' | 'right';

export type DisputeArgumentPlan = {
  paymentHashlocks: string[];
  leftSwapOfferIds: string[];
  rightSwapOfferIds: string[];
  leftPullIds: string[];
  rightPullIds: string[];
};

export type DisputeArgumentSnapshot = {
  // Arguments are positional calldata for one exact proof body. The runtime
  // may delete terminal swaps/pulls later, so older plans must stay immutable.
  proofbodyHash: string;
  nonce: number;
  side: DisputeArgumentSide;
  proofBodyStruct: ProofBodyStruct;
  plan: DisputeArgumentPlan;
};

/**
 * Leaf-level clone used by both Account storage and whole-state cloning.
 * Keep this module free of Runtime/Entity/Account imports: state-helpers sits
 * near the bottom of the dependency graph and must never import a reducer.
 */
export const cloneDisputeArgumentSnapshot = (
  snapshot: DisputeArgumentSnapshot,
): DisputeArgumentSnapshot => ({
  proofbodyHash: snapshot.proofbodyHash,
  nonce: snapshot.nonce,
  side: snapshot.side,
  proofBodyStruct: cloneProofBodyStruct(snapshot.proofBodyStruct),
  plan: {
    paymentHashlocks: [...snapshot.plan.paymentHashlocks],
    leftSwapOfferIds: [...snapshot.plan.leftSwapOfferIds],
    rightSwapOfferIds: [...snapshot.plan.rightSwapOfferIds],
    leftPullIds: [...snapshot.plan.leftPullIds],
    rightPullIds: [...snapshot.plan.rightPullIds],
  },
});
