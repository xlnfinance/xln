import type { AccountConsensusContext } from '../../account/consensus/context';
import { getEntityConfigBoardHash, verifyHankoForHash } from '../../hanko/signing';
import { resolveSigningCertifiedBoardHash } from '../../jurisdiction/machine/board-registry';
import type { EntityRuntimeContext } from '../runtime-context';
import { getAccountJClaimNodeStore } from './account-j-claim-node-store';
import type { AccountJClaimNodeStore } from '../../types/finance/account-j-claims';

const resolveSettlementBoardAuthority = async (
  env: EntityRuntimeContext,
  sourceEntityId: string,
  certifiedBoardHash?: string,
): Promise<string | undefined> => {
  if (certifiedBoardHash) return certifiedBoardHash;
  const source = sourceEntityId.toLowerCase();
  const states = [...env.state.eReplicas.values()]
    .map(replica => replica.state)
    .filter(state => state.entityId.toLowerCase() === source);
  if (states.length === 0) return undefined;
  const configured = new Set(
    await Promise.all(states.map(async state => (
      await getEntityConfigBoardHash(env, state.config)
    ).toLowerCase())),
  );
  if (configured.size !== 1) {
    throw new Error(`SETTLEMENT_SEAL_LOCAL_BOARD_DIVERGENCE:${sourceEntityId}`);
  }
  const configuredBoardHash = [...configured][0]!;
  if (configuredBoardHash === source) return undefined;
  const jurisdiction = states[0]!.config.jurisdiction;
  const certified = resolveSigningCertifiedBoardHash(
    env,
    sourceEntityId,
    jurisdiction,
  );
  if (!certified) {
    throw new Error(`SETTLEMENT_SEAL_BOARD_AUTHORITY_MISSING:${sourceEntityId}`);
  }
  if (certified.toLowerCase() !== configuredBoardHash) {
    throw new Error(
      `SETTLEMENT_SEAL_BOARD_AUTHORITY_MISMATCH:` +
      `${sourceEntityId}:${certified}:${configuredBoardHash}`,
    );
  }
  return certified;
};

export const createAccountConsensusContext = (
  env: EntityRuntimeContext,
  jClaimNodeStore: AccountJClaimNodeStore = getAccountJClaimNodeStore(env),
  observerState?: import('../types').EntityState,
): AccountConsensusContext => ({
  runtimeTimestamp: env.state.timestamp,
  quietLogs: env.quietRuntimeLogs === true,
  emitRuntimeEvents: true,
  jReplicas: env.state.jReplicas,
  jClaimNodeStore,
  verifyHanko: (hanko, hash, expectedEntityId, authority) =>
    verifyHankoForHash(hanko, hash, expectedEntityId, observerState ? env : undefined, {
      ...authority,
      ...(observerState ? { observerState } : {}),
    }),
  resolveSettlementBoardAuthority: (sourceEntityId, certifiedBoardHash) =>
    resolveSettlementBoardAuthority(env, sourceEntityId, certifiedBoardHash),
});
