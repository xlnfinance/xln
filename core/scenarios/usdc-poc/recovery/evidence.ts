import { readFileSync } from 'node:fs';
import { computeCanonicalEntityHashesFromEnv, computeCanonicalStateHashFromEnv } from '../../../storage/canonical-hash';
import { encodeCanonicalConsensusBytes } from '../../../protocol/serialization/binary-codec';
import { keccakBytesHash } from '../../../protocol/crypto/keccak-text';
import { safeStringify } from '../../../protocol/serialization';
import { requireBoundaryRecord } from '../../../protocol/boundary-validation';
import type { PocUser } from '../user';

export const runtimeProof = (user: Pick<PocUser, 'env'>) => ({
  pid: process.pid,
  runtimeId: user.env.runtimeId,
  height: user.env.state.height,
  canonicalStateHash: computeCanonicalStateHashFromEnv(user.env),
  entityHashes: computeCanonicalEntityHashesFromEnv(user.env),
  accounts: [...user.env.state.eReplicas.values()].flatMap(replica =>
    [...replica.state.accounts.entries()].map(([counterparty, account]) => ({
      entityId: replica.entityId,
      counterparty,
      height: account.currentHeight,
      stateHash: account.currentFrame.stateHash,
      accountStateRoot: account.currentFrame.accountStateRoot,
      localFrameHanko: account.currentFrameHanko,
      peerFrameHanko: account.counterpartyFrameHanko,
    })),
  ),
  orderedOutboxDigest: keccakBytesHash(encodeCanonicalConsensusBytes(user.env.pendingNetworkOutputs ?? [])),
});

export const readProof = (path: string) =>
  requireBoundaryRecord(JSON.parse(readFileSync(path, 'utf8')), 'USDC_POC_RECOVERY_PROOF_INVALID');

export const requireSameRestoredProof = (before: Record<string, unknown>, after: Record<string, unknown>): void => {
  if (before['pid'] === after['pid']) throw new Error('USDC_POC_RECOVERY_PROCESS_NOT_REPLACED');
  for (const key of ['runtimeId', 'height', 'canonicalStateHash', 'entityHashes', 'accounts', 'orderedOutboxDigest']) {
    if (safeStringify(before[key]) !== safeStringify(after[key]))
      throw new Error(`USDC_POC_RECOVERY_STATE_MISMATCH:${key}`);
  }
};
