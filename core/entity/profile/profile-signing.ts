import { countOp } from '../../support/performance/op-counters';
import { Signature, keccak256 } from 'ethers';
import { canonicalizeProfile, type Profile } from './';
import type { EntityRuntimeContext } from '../runtime-context';
import type { HankoString } from '../../types/hanko';
import {
  getEntityConfigBoardHash,
  resolveHankoDefaultProposerSignerId,
  verifyHankoForHash,
} from '../../hanko/signing';
import {
  getCertifiedBoardNodeStore,
  getCertifiedBoardStackKey,
  resolveCertifiedRegisteredBoardHash,
  resolveObserverCertifiedBoardRecord,
  resolveObserverCertifiedBoardHash,
} from '../../jurisdiction/machine/board-registry';
import { getSignerAddress, recoverDigestSignerAddress, signAccountFrame } from '../../account/crypto';
import { serializeTaggedJson } from '../../protocol/serialization';
import {
  computeEntityProfileDescriptorHash,
  profileToEntityProfileDescriptor,
} from './profile-descriptor';
import type { EntityState } from '../types';

export const hasCurrentProfileBoardAuthority = async (
  env: EntityRuntimeContext,
  state: EntityState,
): Promise<boolean> => {
  const configBoardHash = (await getEntityConfigBoardHash(env, state.config)).toLowerCase();
  if (configBoardHash === state.entityId.toLowerCase()) return true;
  const record = resolveObserverCertifiedBoardRecord(
    state,
    getCertifiedBoardNodeStore(env),
    state.entityId,
  );
  const jurisdiction = state.config.jurisdiction;
  if (!jurisdiction) return false;
  const discoveredBoardHash = resolveCertifiedRegisteredBoardHash(env, state.entityId, {
    chainId: Number(jurisdiction.chainId),
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
  });
  return record?.boardHash === configBoardHash && discoveredBoardHash === configBoardHash;
};

const PROFILE_ROUTE_DOMAIN = 'xln-profile-runtime-route-v1';
const SECP256K1_HALF_ORDER = BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0');

export const computeProfileHash = (profile: Profile): string => {
  const canonicalProfile = canonicalizeProfile(profile);
  return computeCanonicalProfileHash(canonicalProfile);
};

const computeCanonicalProfileHash = (canonicalProfile: Profile): string =>
  computeEntityProfileDescriptorHash(profileToEntityProfileDescriptor(canonicalProfile));

const computeCanonicalProfileRouteHash = (canonicalProfile: Profile): string => {
  const route = {
    domain: PROFILE_ROUTE_DOMAIN,
    profileHash: computeCanonicalProfileHash(canonicalProfile),
    entityId: canonicalProfile.entityId,
    runtimeId: canonicalProfile.runtimeId,
    runtimeEncPubKey: canonicalProfile.runtimeEncPubKey,
    lastUpdated: canonicalProfile.lastUpdated,
    wsUrl: canonicalProfile.wsUrl,
    relays: canonicalProfile.relays,
    mirrors: canonicalProfile.metadata.mirrors ?? [],
  };
  return keccak256(new TextEncoder().encode(serializeTaggedJson(route)));
};

export const computeProfileRouteHash = (profile: Profile): string => {
  const canonicalProfile = canonicalizeProfile(profile);
  return computeCanonicalProfileRouteHash(canonicalProfile);
};

const resolveProfileCertifiedBoardHash = (
  env: EntityRuntimeContext,
  profile: Profile,
  observerState?: EntityState,
): string | null => {
  const jurisdiction = profile.metadata.jurisdiction;
  if (
    !jurisdiction ||
    !Number.isSafeInteger(Number(jurisdiction.chainId)) ||
    Number(jurisdiction.chainId) <= 0 ||
    typeof jurisdiction.depositoryAddress !== 'string' ||
    typeof jurisdiction.entityProviderAddress !== 'string'
  ) return null;
  if (observerState) {
    const observerJurisdiction = observerState.config.jurisdiction;
    if (!observerJurisdiction) {
      throw new Error(`PROFILE_OBSERVER_JURISDICTION_MISSING:${observerState.entityId}`);
    }
    const claimedJurisdiction = {
      chainId: Number(jurisdiction.chainId),
      depositoryAddress: jurisdiction.depositoryAddress,
      entityProviderAddress: jurisdiction.entityProviderAddress,
    };
    if (getCertifiedBoardStackKey(observerJurisdiction) !== getCertifiedBoardStackKey(claimedJurisdiction)) {
      throw new Error(`PROFILE_OBSERVER_JURISDICTION_MISMATCH:${profile.entityId}`);
    }
    return resolveObserverCertifiedBoardHash(
      observerState,
      getCertifiedBoardNodeStore(env),
      profile.entityId,
    );
  }
  // A missing registration is represented by a null lookup. Any thrown error
  // means the certified store or its authority claim is corrupt/ambiguous and
  // must remain fatal. Falling back to the profile-embedded board in that case
  // would turn local corruption into successful authentication.
  return resolveCertifiedRegisteredBoardHash(env, profile.entityId, {
    chainId: Number(jurisdiction.chainId),
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
  });
};

const assertEntityCertification = async (env: EntityRuntimeContext, profile: Profile): Promise<string> => {
  const hanko = profile.metadata.profileHanko as HankoString | undefined;
  if (!hanko) throw new Error(`PROFILE_ENTITY_CERTIFICATION_REQUIRED: entity=${profile.entityId}`);
  const registeredBoardHash = resolveProfileCertifiedBoardHash(env, profile);
  const profileHash = computeCanonicalProfileHash(profile);
  return resolveHankoDefaultProposerSignerId(hanko, profileHash, profile.entityId, env, {
    ...(registeredBoardHash ? { registeredBoardHash } : {}),
    allowPreviousBoard: false,
  });
};

export async function signProfileRuntimeRoute(
  env: EntityRuntimeContext,
  profile: Profile,
  signerId: string,
): Promise<Profile> {
  const canonicalProfile = canonicalizeProfile(profile);
  const primarySignerAddress = await assertEntityCertification(env, canonicalProfile);
  const signerAddress = getSignerAddress(env, signerId)?.toLowerCase() ?? '';
  if (!signerAddress || signerAddress !== primarySignerAddress) {
    throw new Error(`PROFILE_ROUTE_SIGNER_IDENTITY_MISMATCH: entity=${profile.entityId} signerId=${signerId}`);
  }
  const { runtimeSignature: _previousSignature, ...withoutRuntimeSignature } = canonicalProfile;
  const unsigned = canonicalizeProfile(withoutRuntimeSignature);
  const runtimeSignature = signAccountFrame(env, signerId, computeProfileRouteHash(unsigned));
  return canonicalizeProfile({ ...unsigned, runtimeSignature });
}

export type ProfileVerifyResult = {
  valid: boolean;
  reason?: string;
  hash?: string;
  signerId?: string;
};

const hasCanonicalRouteSignature = (signature: string): boolean => {
  if (!/^0x[0-9a-f]{128}0[01]$/i.test(signature)) return false;
  try {
    const parsed = Signature.from(signature);
    return BigInt(parsed.s) > 0n && BigInt(parsed.s) <= SECP256K1_HALF_ORDER;
  } catch {
    return false;
  }
};

const verifyRuntimeRouteSignature = (profile: Profile, signerId: string): ProfileVerifyResult => {
  const signature = String(profile.runtimeSignature || '').trim().toLowerCase();
  if (!hasCanonicalRouteSignature(signature)) return { valid: false, reason: 'runtime_signature_non_canonical', signerId };
  const hash = computeCanonicalProfileRouteHash(profile);
  if (recoverDigestSignerAddress(hash, signature) !== signerId) {
    return { valid: false, reason: 'runtime_signature_invalid', hash, signerId };
  }
  return { valid: true, hash, signerId };
};

/*
 * Gossip re-delivers the same entity certification every cycle, and each
 * delivery re-ran a full Hanko verification: ABI encode, keccak and ECDSA
 * recovery per claim. The certified proposer depends only on the profile
 * hash, the Hanko bytes and the board it is checked against — all three are
 * in the key, so a rotated board or an edited profile re-verifies rather than
 * reusing a stale verdict. The runtime route signature is NOT covered by that
 * key (a route re-signs with every `lastUpdated` bump and is what binds the
 * runtime endpoint), so it is verified on every call.
 */
const PROFILE_CERTIFICATION_CACHE_MAX = 4_096;
const profileCertificationCache = new Map<string, string>();

const rememberCertifiedSigner = (key: string, signerId: string): string => {
  if (profileCertificationCache.size >= PROFILE_CERTIFICATION_CACHE_MAX) {
    const oldest = profileCertificationCache.keys().next();
    if (!oldest.done) profileCertificationCache.delete(oldest.value);
  }
  profileCertificationCache.set(key, signerId);
  return signerId;
};

export async function verifyProfileSignature(
  profile: Profile,
  env?: EntityRuntimeContext,
  observerState?: EntityState,
): Promise<ProfileVerifyResult> {
  countOp('profile.verifySignature');
  const canonicalProfile = canonicalizeProfile(profile);
  // From this line down every helper consumes the exact canonical object.
  // Re-entering public normalization here used to parse/encode the same signed
  // profile up to five times during one authority check.
  const hash = computeCanonicalProfileHash(canonicalProfile);
  const hanko = canonicalProfile.metadata.profileHanko as HankoString | undefined;
  if (!hanko) return { valid: false, reason: 'entity_certification_missing', hash };
  let registeredBoardHash: string | null = null;
  if (env && canonicalProfile.metadata.jurisdiction) {
    registeredBoardHash = resolveProfileCertifiedBoardHash(env, canonicalProfile, observerState);
  }
  const certificationCacheKey = observerState
    ? null
    : `${hash}|${String(hanko)}|${registeredBoardHash ?? ''}`;
  let signerId = certificationCacheKey ? profileCertificationCache.get(certificationCacheKey) : undefined;
  if (signerId !== undefined) {
    countOp('profile.verifySignature.cacheHit');
  } else {
    const entityResult = await verifyHankoForHash(
      hanko,
      hash,
      canonicalProfile.entityId,
      env,
      {
        ...(registeredBoardHash ? { registeredBoardHash } : {}),
        allowPreviousBoard: false,
        ...(observerState ? { observerState } : {}),
      },
    );
    if (!entityResult.valid) return { valid: false, reason: 'entity_certification_invalid', hash };
    try {
      signerId = await resolveHankoDefaultProposerSignerId(hanko, hash, canonicalProfile.entityId, env, {
        ...(registeredBoardHash ? { registeredBoardHash } : {}),
        allowPreviousBoard: false,
        ...(observerState ? { observerState } : {}),
      });
    } catch {
      return { valid: false, reason: 'entity_certification_board_invalid', hash };
    }
    if (certificationCacheKey) rememberCertifiedSigner(certificationCacheKey, signerId);
  }
  return verifyRuntimeRouteSignature(canonicalProfile, signerId);
}
