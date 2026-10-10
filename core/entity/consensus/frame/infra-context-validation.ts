import { timePerfPhase } from '../../../support/performance/profile';
import { parseProfile, type DecodedProfile } from '../../profile';
import { canonicalConsensusValuesEqual } from '../../../protocol/serialization/binary-codec';
import { validateHtlcPreparedInfraContext } from '../../paybook/prepared-context-validation';
import { getEffectiveHtlcFrameTxs } from '../../paybook/materialize-context';
import { hashRawHtlcPaymentTx } from '../../paybook/payment-admission';
import type { EntityInfraContext } from '../../../types/entity/infra-context';
import type { EntityTx } from '../../../types/entity-tx';
import type { EntityRuntimeContext } from '../../runtime-context';
import { verifyProfileSignature } from '../../profile/profile-signing';
import { MalformedEntityFrameInputError } from '../../tx/processing/invariant-errors';
import type { EntityState } from '../../types';
import {
  toEntityId,
  toSignerId,
  type EntityId,
  type SignerId,
} from '../../../protocol/identity';
import { toFrameHash, type FrameHash } from '../../../protocol/hashes';
import { toEntityHeight, type EntityHeight } from '../../../protocol/units';

const bytes32 = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) throw new Error(code);
  return value;
};

const exactKeys = (value: unknown, keys: readonly string[], code: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(',')) throw new Error(`${code}:FIELDS`);
  return record;
};

const canonicalProfile = (value: unknown): DecodedProfile => {
  const parsed = parseProfile(value);
  // `parseProfile` preserves identity only for an object already proven and
  // frozen by that parser. Remote/WAL objects are distinct and retain the
  // byte-for-byte canonicality comparison.
  if (value !== parsed && !canonicalConsensusValuesEqual(value, parsed)) {
    throw new Error(`ENTITY_INFRA_PROFILE_NONCANONICAL:${parsed.entityId}`);
  }
  return parsed;
};

export type DecodedEntityInfraContext = EntityInfraContext & Readonly<{
  entityId: EntityId;
  proposerSignerId: SignerId;
  parentFrameHash: FrameHash | 'genesis';
  height: EntityHeight;
  gossipProfiles: DecodedProfile[];
  peerAssertions: ReadonlyArray<Readonly<{
    entityId: EntityId;
    online: boolean;
  }>>;
}>;

/** One strict parser shared by network frame, deterministic apply, and WAL boundaries. */
export const validateEntityInfraContext = (value: unknown): DecodedEntityInfraContext => {
  const raw = exactKeys(value, [
    'version', 'proposerReplicaId', 'entityId', 'proposerSignerId', 'parentFrameHash',
    'height', 'gossipProfiles', 'peerAssertions', 'htlc',
  ], 'ENTITY_INFRA_CONTEXT_INVALID');
  if (raw['version'] !== 1) throw new Error('ENTITY_INFRA_CONTEXT_VERSION_INVALID');
  const entityId = toEntityId(bytes32(raw['entityId'], 'ENTITY_INFRA_ENTITY_ID_INVALID'));
  const rawProposerSignerId = String(raw['proposerSignerId'] ?? '');
  if (!rawProposerSignerId || rawProposerSignerId !== rawProposerSignerId.trim().toLowerCase()) {
    throw new Error('ENTITY_INFRA_PROPOSER_SIGNER_ID_INVALID');
  }
  const proposerSignerId = toSignerId(rawProposerSignerId);
  const proposerReplicaId = String(raw['proposerReplicaId'] ?? '');
  if (proposerReplicaId !== `${entityId}:${proposerSignerId}`) {
    throw new Error('ENTITY_INFRA_PROPOSER_REPLICA_ID_INVALID');
  }
  const rawParentFrameHash = String(raw['parentFrameHash'] ?? '');
  const parentFrameHash = rawParentFrameHash === 'genesis'
    ? 'genesis'
    : toFrameHash(bytes32(rawParentFrameHash, 'ENTITY_INFRA_PARENT_HASH_INVALID'));
  const height = raw['height'];
  if (!Number.isSafeInteger(height) || Number(height) < 1) throw new Error('ENTITY_INFRA_HEIGHT_INVALID');
  const entityHeight = toEntityHeight(Number(height));
  if (!Array.isArray(raw['gossipProfiles'])) throw new Error('ENTITY_INFRA_PROFILES_INVALID');
  const gossipProfiles = raw['gossipProfiles'].map(canonicalProfile);
  let previousProfileId = '';
  for (const profile of gossipProfiles) {
    if (profile.entityId !== profile.entityId.toLowerCase() || profile.entityId <= previousProfileId) {
      throw new Error('ENTITY_INFRA_PROFILES_NONCANONICAL');
    }
    previousProfileId = profile.entityId;
  }
  if (!Array.isArray(raw['peerAssertions'])) throw new Error('ENTITY_INFRA_PEER_ASSERTIONS_INVALID');
  const profileIds = new Set<string>(gossipProfiles.map(profile => profile.entityId));
  let previousPeerId = '';
  const peerAssertions = raw['peerAssertions'].map((value, index) => {
    const peer = exactKeys(value, ['entityId', 'online'], `ENTITY_INFRA_PEER_ASSERTION_INVALID:${index}`);
    const peerEntityId = toEntityId(bytes32(peer['entityId'], `ENTITY_INFRA_PEER_ENTITY_ID_INVALID:${index}`));
    if (peerEntityId <= previousPeerId || typeof peer['online'] !== 'boolean') {
      throw new Error(`ENTITY_INFRA_PEER_ASSERTION_NONCANONICAL:${index}`);
    }
    previousPeerId = peerEntityId;
    return { entityId: peerEntityId, online: peer['online'] };
  });
  const htlc = timePerfPhase('entity.infraValidate.htlc', () => validateHtlcPreparedInfraContext(raw['htlc']));
  // Profiles are consumed only by originated-payment replay (fee quotes,
  // hop encryption keys, account domains). Forward entries and peer
  // assertions need no profile: a Hub frame that forwards to hundreds of
  // users otherwise embedded hundreds of signed profiles (megabytes, and a
  // signature verification each) into every frame. Contexts written before
  // this change may still carry those profiles, so they stay admissible.
  const requiredProfileIds = new Set<string>();
  for (const originated of htlc.originated) {
    for (const routeEntityId of originated.route) requiredProfileIds.add(routeEntityId);
  }
  const admissibleProfileIds = new Set<string>(requiredProfileIds);
  for (const assertion of peerAssertions) admissibleProfileIds.add(assertion.entityId);
  for (const entry of htlc.entries) {
    if (entry.outcome.kind === 'forward') admissibleProfileIds.add(entry.outcome.nextHopEntityId);
  }
  if (
    [...requiredProfileIds].some(profileId => !profileIds.has(profileId)) ||
    [...profileIds].some(profileId => !admissibleProfileIds.has(profileId))
  ) {
    throw new Error('ENTITY_INFRA_PROFILE_SET_NOT_EXACT');
  }
  // Byte bounds are enforced once on the whole frame (wire fit on the
  // proposer, the total-frame budget on every validator); the context is a
  // part of that frame, not a second budget.
  return {
    version: 1, proposerReplicaId, entityId, proposerSignerId, parentFrameHash,
    height: entityHeight, gossipProfiles, peerAssertions, htlc,
  };
};

/** The top-level frame tx whose originated payment routes through `entityId`. */
const originatedPaymentOwner = (
  state: EntityState,
  frameTxs: readonly EntityTx[],
  context: EntityInfraContext,
  entityId: string,
): EntityTx | undefined => {
  const txHashes = new Set(context.htlc.originated
    .filter(originated => originated.route.includes(entityId))
    .map(originated => originated.txHash));
  return frameTxs.find(tx => getEffectiveHtlcFrameTxs(state, [tx]).some(child =>
    child.type === 'htlcPayment' && txHashes.has(hashRawHtlcPaymentTx(child))));
};

/**
 * Authenticate every committed Profile before any key/domain/capacity is
 * trusted. Profiles come from public gossip: one that fails here (a foreign
 * stack, a rotated board) rejects the payment routed through it. The proposer
 * evicts that tx; a validator rejects the proposal.
 */
export const assertEntityInfraContextAuthority = async (
  env: EntityRuntimeContext,
  context: EntityInfraContext,
  observerState: EntityState,
  frameTxs: readonly EntityTx[],
): Promise<void> => {
  for (const profile of context.gossipProfiles) {
    const result = await verifyProfileSignature(profile, env, observerState);
    if (result.valid) continue;
    const entityId = profile.entityId.toLowerCase();
    const owner = originatedPaymentOwner(observerState, frameTxs, context, entityId);
    const rejected = new MalformedEntityFrameInputError(
      owner?.type ?? 'htlcPayment',
      `HTLC_PAYMENT_PROFILE_AUTHORITY_INVALID:${entityId}:${result.reason ?? 'unknown'}`,
    );
    if (owner) rejected.frameTx = owner;
    rejected.attemptedEntityContext = context;
    throw rejected;
  }
};
