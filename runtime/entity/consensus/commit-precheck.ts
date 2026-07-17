import { verifyAccountSignature } from '../../account/crypto';
import type {
  ConsensusConfig,
  EntityReplica,
  Env,
  HashToSign,
  ProposedEntityFrame,
  RoutedEntityInput,
} from '../../types';
import { createEntityFrameHashFromStateRoot, isCanonicalEntityFrameDigest } from './frame';
import { getEntityHashManifestMismatch } from './hanko-witness';
import { encodeCanonicalEntityConsensusValue } from './state-root';

const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const exactReplica = (env: Env, input: RoutedEntityInput): EntityReplica | null => {
  const entityId = normalize(input.entityId);
  const signerId = normalize(input.signerId);
  for (const replica of env.eReplicas.values()) {
    if (normalize(replica.entityId || replica.state.entityId) !== entityId) continue;
    if (normalize(replica.signerId) !== signerId) continue;
    return replica;
  }
  return null;
};

const locallyValidatedFrame = (
  replica: EntityReplica,
  frame: ProposedEntityFrame,
): ProposedEntityFrame | null => [replica.lockedFrame, replica.proposal].find(candidate =>
  candidate?.height === frame.height && candidate.hash === frame.hash) ?? null;

const frameBodyAndLeaderMatchesLocalReplay = (
  replica: EntityReplica,
  localFrame: ProposedEntityFrame,
  candidate: ProposedEntityFrame,
): boolean => {
  if (
    !isCanonicalEntityFrameDigest(candidate.hash) ||
    !isCanonicalEntityFrameDigest(candidate.stateRoot) ||
    !isCanonicalEntityFrameDigest(candidate.authorityRoot)
  ) return false;
  try {
    const recomputed = createEntityFrameHashFromStateRoot(
      candidate.parentFrameHash,
      candidate.height,
      candidate.timestamp,
      candidate.txs,
      replica.state.entityId,
      candidate.stateRoot,
      candidate.authorityRoot,
      candidate.jPrefixCertificate,
    );
    if (recomputed !== candidate.hash) return false;
  } catch {
    return false;
  }
  // Leader certificates are not part of the frame hash. Require the exact
  // metadata this validator already accepted; otherwise public frame QC bytes
  // could be attached to a forged proposer/view and steal the capped slot.
  return encodeCanonicalEntityConsensusValue(candidate.leader) ===
    encodeCanonicalEntityConsensusValue(localFrame.leader);
};

const signerShares = (config: ConsensusConfig, signerId: string): bigint | null => {
  if (!config.validators.some(validator => normalize(validator) === signerId)) return null;
  const shares = Object.entries(config.shares).find(([candidate]) => normalize(candidate) === signerId)?.[1];
  return typeof shares === 'bigint' && shares > 0n ? shares : null;
};

/**
 * Scheduling precheck only: proves that a real configured quorum signed the
 * claimed manifest. Consensus still replays state and recomputes every hash.
 */
export const hasVerifiedEntityCommitPrecertificate = (
  env: Env,
  input: RoutedEntityInput,
): boolean => {
  const frame = input.proposedFrame;
  const replica = frame ? exactReplica(env, input) : null;
  const config = replica?.state.config;
  if (!frame || !replica || !config || !(frame.collectedSigs instanceof Map)) return false;

  // Signatures over proposer-supplied hashes are not a scheduling certificate.
  // An attacker can replay a public quorum bundle over another frame, or strip
  // every secondary hash and its matching signatures from a real commit. Only
  // a manifest this replica already derived by replay is trusted before the
  // runtime frame cap; full consensus validation remains authoritative.
  const localFrame = locallyValidatedFrame(replica, frame);
  if (!localFrame || !frameBodyAndLeaderMatchesLocalReplay(replica, localFrame, frame)) return false;
  const hashes: HashToSign[] | undefined = localFrame.hashesToSign;
  if (
    !hashes?.length ||
    hashes[0]?.type !== 'entityFrame' ||
    normalize(hashes[0].hash) !== normalize(frame.hash) ||
    getEntityHashManifestMismatch(hashes, frame.hashesToSign)
  ) {
    return false;
  }
  const seen = new Set<string>();
  let power = 0n;
  for (const [rawSignerId, signatures] of frame.collectedSigs) {
    const signerId = normalize(rawSignerId);
    const shares = signerShares(config, signerId);
    if (!shares || seen.has(signerId) || !Array.isArray(signatures) || signatures.length !== hashes.length) {
      return false;
    }
    seen.add(signerId);
    if (hashes.some((hash, index) => !signatures[index] ||
      !verifyAccountSignature(env, signerId, hash.hash, signatures[index]!))) return false;
    power += shares;
  }
  return power >= config.threshold;
};
