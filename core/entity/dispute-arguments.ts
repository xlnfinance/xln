import { ethers } from 'ethers';

import type { AccountReplica } from '../types/account';
import {
  buildCurrentDisputeArgumentPlan,
  buildDisputeArgumentsFromState,
  type DisputeArgumentSide,
} from '../protocol/dispute/arguments';
import {
  buildAccountProofBodyFromJurisdictions,
  type AccountJurisdictionView,
} from '../account/consensus/helpers';
import type { EntityState } from './types';

export type { DisputeArgumentSide } from '../protocol/dispute/arguments';

const hashHtlcSecret = (secret: string): string =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32'], [secret])).toLowerCase();

/**
 * Return only preimages committed by the exact frozen AccountState.
 *
 * Counterexample: publishing every secret ever learned from one counterparty
 * lets unrelated completed routes exhaust the jurisdiction batch cap and
 * prevent an otherwise valid dispute from closing. Frozen AccountState is the
 * authority; live Entity routes are only optional evidence for its hashlocks.
 */
export const collectKnownDisputeSecretsForState = (
  account: AccountReplica,
  entityState: EntityState,
  counterpartyEntityId: string,
): string[] => {
  const plan = buildCurrentDisputeArgumentPlan(account);
  if (entityState.paybook.entries.size === 0 || plan.paymentHashlocks.length === 0) return [];
  const seen = new Set<string>();
  const secrets: string[] = [];
  // AccountState already names the exact hashlocks required by the frozen
  // proof. Point-read those paybook entries in transformer order; scanning the
  // whole Entity paybook made one disputed Account O(all active payments) and
  // could also return secrets in unrelated insertion order.
  for (const rawHashlock of plan.paymentHashlocks) {
    const hashlock = rawHashlock.toLowerCase();
    const route = entityState.paybook.entries.get(hashlock);
    if (!route || route.hashlock.toLowerCase() !== hashlock) continue;
    if (!route.secret || !/^0x[0-9a-fA-F]{64}$/.test(route.secret)) continue;
    if (route.inboundEntity !== counterpartyEntityId && route.outboundEntity !== counterpartyEntityId) {
      continue;
    }
    if (hashHtlcSecret(route.secret) !== hashlock || seen.has(route.secret)) continue;
    seen.add(route.secret);
    secrets.push(route.secret);
  }
  return secrets;
};

export const buildDisputeArgumentsForCurrentState = (
  account: AccountReplica,
  entityState: EntityState,
  jurisdictions: AccountJurisdictionView,
  counterpartyEntityId: string,
  proofbodyHash: string,
  options: { secretsSide: DisputeArgumentSide | 'none' },
): ReturnType<typeof buildDisputeArgumentsFromState> => {
  const currentProof = buildAccountProofBodyFromJurisdictions(jurisdictions, account);
  if (currentProof.proofBodyHash.toLowerCase() !== proofbodyHash.toLowerCase()) {
    throw new Error(
      `DISPUTE_FROZEN_STATE_PROOF_MISMATCH:${proofbodyHash}:${currentProof.proofBodyHash}`,
    );
  }
  return buildDisputeArgumentsFromState(
    account,
    options,
    collectKnownDisputeSecretsForState(
      account,
      entityState,
      counterpartyEntityId,
    ),
  );
};
