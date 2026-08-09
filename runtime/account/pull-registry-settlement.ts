import { ethers } from 'ethers';

import type { AccountReplica } from '../types/account';
import type {
  CrossJurisdictionPullLeg,
  CrossJurisdictionSwapLeg,
} from '../types/cross-jurisdiction';
import { BATCH_ABI, type ProofBodyStruct } from '../protocol/dispute/proof-body';

const DELTA_BATCH_PARAM = ethers.ParamType.from(BATCH_ABI);
const MAX_FILL_RATIO = 0xffff;

export type HashLadderRegistryRecord = Readonly<{
  fillRatio: number;
  revealedAt: number;
}>;

type FinalizedRouteProjection = Readonly<{
  orderId: string;
  source: CrossJurisdictionSwapLeg;
  target: CrossJurisdictionSwapLeg;
}>;

export type SignedProofBodyPull = Readonly<{
  amount: bigint;
  claimedRatio: number;
  targetRole: boolean;
  fullHash: string;
  partialRoot: string;
}>;

const safeUint = (value: unknown, max: number, code: string): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > max) {
    throw new Error(`${code}:${String(value)}`);
  }
  return number;
};

export const decodeSignedProofBodyPulls = (
  proofbody: ProofBodyStruct,
  canonicalDeltaTransformerAddress: string,
): SignedProofBodyPull[] => {
  if (!ethers.isAddress(canonicalDeltaTransformerAddress)) {
    throw new Error(
      `CROSS_J_FINAL_DELTA_TRANSFORMER_ADDRESS_INVALID:${canonicalDeltaTransformerAddress}`,
    );
  }
  const canonical = canonicalDeltaTransformerAddress.toLowerCase();
  const pulls: SignedProofBodyPull[] = [];
  let canonicalClauses = 0;
  for (const [transformerIndex, transformer] of proofbody.transformers.entries()) {
    if (String(transformer.transformerAddress).toLowerCase() !== canonical) continue;
    canonicalClauses += 1;
    let decoded: ethers.Result;
    try {
      decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        [DELTA_BATCH_PARAM],
        transformer.encodedBatch,
      )[0];
    } catch (cause) {
      throw new Error(`CROSS_J_FINAL_DELTA_BATCH_INVALID:${transformerIndex}`, { cause });
    }
    const decodedPulls = Array.from(decoded['pull'] ?? []) as ethers.Result[];
    for (const [pullIndex, raw] of decodedPulls.entries()) {
      pulls.push({
        amount: BigInt(raw['amount']),
        claimedRatio: safeUint(
          raw['claimedRatio'],
          MAX_FILL_RATIO,
          `CROSS_J_FINAL_PULL_RATIO_${transformerIndex}_${pullIndex}`,
        ),
        targetRole: raw['targetRole'] === true,
        fullHash: String(raw['fullHash']).toLowerCase(),
        partialRoot: String(raw['partialRoot']).toLowerCase(),
      });
    }
  }
  if (canonicalClauses === 0) throw new Error('CROSS_J_FINAL_DELTA_TRANSFORMER_MISSING');
  return pulls;
};

export const findExactSignedProofBodyPull = (
  proofbody: ProofBodyStruct,
  expected: CrossJurisdictionPullLeg,
  targetRole: boolean,
  canonicalDeltaTransformerAddress: string,
): SignedProofBodyPull | undefined => {
  const matches = decodeSignedProofBodyPulls(
    proofbody,
    canonicalDeltaTransformerAddress,
  ).filter(pull =>
    pull.targetRole === targetRole
    && pull.fullHash === expected.fullHash.toLowerCase()
    && pull.partialRoot === expected.partialRoot.toLowerCase()
    && pull.amount === expected.signedAmount
  );
  if (matches.length > 1) {
    throw new Error(
      'CROSS_J_FINAL_PULL_AMBIGUOUS:' +
      `${expected.pullId}:${targetRole ? 'target' : 'source'}`,
    );
  }
  return matches[0];
};

const requireExactSignedPull = (
  proofbody: ProofBodyStruct,
  expected: CrossJurisdictionPullLeg,
  targetRole: boolean,
  canonicalDeltaTransformerAddress: string,
): SignedProofBodyPull => {
  const pull = findExactSignedProofBodyPull(
    proofbody,
    expected,
    targetRole,
    canonicalDeltaTransformerAddress,
  );
  if (!pull) {
    throw new Error(
      `CROSS_J_FINAL_PULL_MISSING:${expected.pullId}:${targetRole ? 'target' : 'source'}`,
    );
  }
  return pull;
};

const beneficiaryWindowSeconds = (
  account: AccountReplica,
  proofbody: ProofBodyStruct,
  amount: bigint,
): number => {
  const leftWindow = safeUint(proofbody.leftResponseSeconds, 0xffff_ffff, 'CROSS_J_FINAL_LEFT_WINDOW');
  const rightWindow = safeUint(proofbody.rightResponseSeconds, 0xffff_ffff, 'CROSS_J_FINAL_RIGHT_WINDOW');
  const active = account.activeDispute;
  const start = safeUint(active?.disputeStartTimestamp, Number.MAX_SAFE_INTEGER, 'CROSS_J_FINAL_START');
  const timeout = safeUint(active?.disputeTimeout, Number.MAX_SAFE_INTEGER, 'CROSS_J_FINAL_TIMEOUT');
  if (timeout !== start + leftWindow + rightWindow) {
    throw new Error(`CROSS_J_FINAL_CLOCK_MISMATCH:${start}:${timeout}:${leftWindow}:${rightWindow}`);
  }
  return amount > 0n ? leftWindow : rightWindow;
};

const bilateralPairMatches = (
  self: string,
  counterparty: string,
  leg: CrossJurisdictionSwapLeg,
): boolean => {
  const entity = leg.entityId.toLowerCase();
  const peer = leg.counterpartyEntityId.toLowerCase();
  return (entity === self && peer === counterparty) || (entity === counterparty && peer === self);
};

/**
 * Select the finalized route leg by unordered bilateral Account pair and the
 * exact local contract stack. Every user and Hub stores the same route, so
 * direction alone is insufficient; the stack discriminator also prevents a
 * repeated entity pair on two chains from consuming the wrong finality event.
 */
export const resolveFinalizedCrossJurisdictionRouteLeg = (input: {
  route: FinalizedRouteProjection;
  self: string;
  counterparty: string;
  localStack?: string;
}): 'source' | 'target' | undefined => {
  const self = input.self.toLowerCase();
  const counterparty = input.counterparty.toLowerCase();
  const candidates = (['source', 'target'] as const)
    .filter(role => bilateralPairMatches(self, counterparty, input.route[role]));
  if (candidates.length === 0) return undefined;
  if (!input.localStack) {
    throw new Error(`CROSS_J_FINALITY_JURISDICTION_MISSING:${input.route.orderId}`);
  }
  const localStack = input.localStack.toLowerCase();
  const exact = candidates.filter(
    role => input.route[role].jurisdiction.toLowerCase() === localStack,
  );
  if (exact.length !== 1) {
    throw new Error(
      `CROSS_J_FINALITY_LEG_${exact.length === 0 ? 'MISSING' : 'AMBIGUOUS'}:` +
      input.route.orderId,
    );
  }
  return exact[0]!;
};

/**
 * Mirror DeltaTransformer.applyPull exactly for route terminal accounting.
 * A late Target record remains durable evidence, but it contributes zero;
 * the already signed claimedRatio is still part of the final ProofBody state.
 */
export const resolveFinalizedPullFillRatio = (input: {
  account: AccountReplica;
  proofbody: ProofBodyStruct;
  canonicalDeltaTransformerAddress: string;
  expectedPull: CrossJurisdictionPullLeg;
  targetRole: boolean;
  record?: HashLadderRegistryRecord;
}): number => {
  const pull = requireExactSignedPull(
    input.proofbody,
    input.expectedPull,
    input.targetRole,
    input.canonicalDeltaTransformerAddress,
  );
  const beneficiaryWindow = beneficiaryWindowSeconds(input.account, input.proofbody, pull.amount);
  const start = Number(input.account.activeDispute!.disputeStartTimestamp);
  const record = input.record;
  if (!record) return pull.claimedRatio;
  const ratio = safeUint(record.fillRatio, MAX_FILL_RATIO, 'CROSS_J_REGISTRY_RECORD_RATIO');
  const revealedAt = safeUint(record.revealedAt, Number.MAX_SAFE_INTEGER, 'CROSS_J_REGISTRY_RECORD_TIME');
  const timely = revealedAt >= start && revealedAt <= start + beneficiaryWindow;
  return timely && ratio > pull.claimedRatio ? ratio : pull.claimedRatio;
};
