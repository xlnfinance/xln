import { Signature, keccak256, recoverAddress } from 'ethers';
import { canonicalizeProfile, type Profile } from './';
import type { EntityRuntimeContext } from '../runtime-context';
import type { HankoString } from '../../types/hanko';
import { resolveHankoDefaultProposerSignerId, verifyHankoForHash } from '../../hanko/signing';
import {
  getCertifiedBoardNodeStore,
  getCertifiedBoardStackKey,
  resolveCertifiedRegisteredBoardHash,
  resolveObserverCertifiedBoardHash,
} from '../../jurisdiction/machine/board-registry';
import { getSignerAddress, signAccountFrame } from '../../account/crypto';
import { serializeTaggedJson } from '../../protocol/serialization';
import {
  computeEntityProfileDescriptorHash,
  profileToEntityProfileDescriptor,
} from './profile-descriptor';
import type { EntityState } from '../types';

const PROFILE_ROUTE_DOMAIN = 'xln-profile-runtime-route-v1';
const SECP256K1_HALF_ORDER = BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0');

export const computeProfileHash = (profile: Profile): string => {
  const canonicalProfile = canonicalizeProfile(profile);
  return computeEntityProfileDescriptorHash(profileToEntityProfileDescriptor(canonicalProfile));
};

export const computeProfileRouteHash = (profile: Profile): string => {
  const canonicalProfile = canonicalizeProfile(profile);
  const route = {
    domain: PROFILE_ROUTE_DOMAIN,
    profileHash: computeProfileHash(canonicalProfile),
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
  const profileHash = computeProfileHash(profile);
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
  const hash = computeProfileRouteHash(profile);
  if (recoverAddress(hash, signature).toLowerCase() !== signerId) {
    return { valid: false, reason: 'runtime_signature_invalid', hash, signerId };
  }
  return { valid: true, hash, signerId };
};

export async function verifyProfileSignature(
  profile: Profile,
  env?: EntityRuntimeContext,
  observerState?: EntityState,
): Promise<ProfileVerifyResult> {
  const canonicalProfile = canonicalizeProfile(profile);
  const hash = computeProfileHash(canonicalProfile);
  const hanko = canonicalProfile.metadata.profileHanko as HankoString | undefined;
  if (!hanko) return { valid: false, reason: 'entity_certification_missing', hash };
  let registeredBoardHash: string | null = null;
  if (env && canonicalProfile.metadata.jurisdiction) {
    registeredBoardHash = resolveProfileCertifiedBoardHash(env, canonicalProfile, observerState);
  }
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
    const signerId = await resolveHankoDefaultProposerSignerId(hanko, hash, canonicalProfile.entityId, env, {
      ...(registeredBoardHash ? { registeredBoardHash } : {}),
      allowPreviousBoard: false,
      ...(observerState ? { observerState } : {}),
    });
    return verifyRuntimeRouteSignature(canonicalProfile, signerId);
  } catch {
    return { valid: false, reason: 'entity_certification_board_invalid', hash };
  }
}
