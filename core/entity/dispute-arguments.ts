import { ethers } from 'ethers';

import type { AccountReplica } from '../types/account';
import {
  buildDisputeArgumentsFromSnapshot,
  requireDisputeArgumentSnapshot,
  type DisputeArgumentSide,
} from '../protocol/dispute/arguments';
import type { EntityState } from './types';

export type { DisputeArgumentSide } from '../protocol/dispute/arguments';

const hashHtlcSecret = (secret: string): string =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32'], [secret])).toLowerCase();

/**
 * Return only preimages committed by the exact signed ProofBody snapshot.
 *
 * Counterexample: publishing every secret ever learned from one counterparty
 * lets unrelated completed routes exhaust the jurisdiction batch cap and
 * prevent an otherwise valid dispute from closing. The signed snapshot is the
 * authority; live Entity routes are only optional evidence for its hashlocks.
 */
export const collectKnownDisputeSecretsForSnapshot = (
  account: AccountReplica,
  entityState: EntityState,
  counterpartyEntityId: string,
  proofbodyHash: string,
): string[] => {
  const snapshot = requireDisputeArgumentSnapshot(account, proofbodyHash, 'secrets');
  if (!entityState.htlcRoutes?.size || snapshot.plan.paymentHashlocks.length === 0) return [];
  const required = new Set(snapshot.plan.paymentHashlocks.map(hashlock => hashlock.toLowerCase()));
  const seen = new Set<string>();
  const secrets: string[] = [];
  for (const route of entityState.htlcRoutes.values()) {
    if (!route.secret || !/^0x[0-9a-fA-F]{64}$/.test(route.secret)) continue;
    if (route.inboundEntity !== counterpartyEntityId && route.outboundEntity !== counterpartyEntityId) {
      continue;
    }
    if (!required.has(hashHtlcSecret(route.secret)) || seen.has(route.secret)) continue;
    seen.add(route.secret);
    secrets.push(route.secret);
  }
  return secrets;
};

export const buildDisputeArgumentsForSnapshot = (
  account: AccountReplica,
  entityState: EntityState,
  counterpartyEntityId: string,
  proofbodyHash: string,
  options: { secretsSide: DisputeArgumentSide | 'none' },
): ReturnType<typeof buildDisputeArgumentsFromSnapshot> =>
  buildDisputeArgumentsFromSnapshot(
    account,
    proofbodyHash,
    options,
    collectKnownDisputeSecretsForSnapshot(
      account,
      entityState,
      counterpartyEntityId,
      proofbodyHash,
    ),
  );
