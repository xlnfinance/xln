import { Signature, keccak256, recoverAddress } from 'ethers';
import { canonicalizeProfile, type Profile } from './gossip';
import type { Env, HankoString } from '../types';
import { verifyHankoForHash } from '../hanko/signing';
import { resolveCertifiedRegisteredBoardHash } from '../jurisdiction/board-registry';
import { getSignerAddress, getSignerPublicKey, signAccountFrame } from '../account/crypto';
import { serializeTaggedJson } from '../protocol/serialization';
import {
  computeEntityProfileDescriptorHash,
  profileToEntityProfileDescriptor,
} from './profile-descriptor';

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
    runtimeSignerId: canonicalProfile.runtimeSignerId,
    runtimeEncPubKey: canonicalProfile.runtimeEncPubKey,
    lastUpdated: canonicalProfile.lastUpdated,
    wsUrl: canonicalProfile.wsUrl,
    relays: canonicalProfile.relays,
    mirrors: canonicalProfile.metadata.mirrors ?? [],
  };
  return keccak256(new TextEncoder().encode(serializeTaggedJson(route)));
};

const boardValidatorFor = (profile: Profile, signerId: string) => {
  const target = signerId.trim().toLowerCase();
  return profile.metadata.board.validators.find(
    (validator) => validator.signerId.trim().toLowerCase() === target,
  );
};

const resolveProfileCertifiedBoardHash = (env: Env, profile: Profile): string | null => {
  const jurisdiction = profile.metadata.jurisdiction;
  if (
    !jurisdiction ||
    !Number.isSafeInteger(Number(jurisdiction.chainId)) ||
    Number(jurisdiction.chainId) <= 0 ||
    typeof jurisdiction.depositoryAddress !== 'string' ||
    typeof jurisdiction.entityProviderAddress !== 'string'
  ) return null;
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

const assertEntityCertification = async (env: Env, profile: Profile): Promise<void> => {
  const hanko = profile.metadata.profileHanko as HankoString | undefined;
  if (!hanko) throw new Error(`PROFILE_ENTITY_CERTIFICATION_REQUIRED: entity=${profile.entityId}`);
  const registeredBoardHash = resolveProfileCertifiedBoardHash(env, profile);
  const result = await verifyHankoForHash(
    hanko,
    computeProfileHash(profile),
    profile.entityId,
    env,
    registeredBoardHash ? { registeredBoardHash } : undefined,
  );
  if (!result.valid) throw new Error(`PROFILE_ENTITY_CERTIFICATION_INVALID: entity=${profile.entityId}`);
};

export async function signProfileRuntimeRoute(
  env: Env,
  profile: Profile,
  signerId: string,
): Promise<Profile> {
  const canonicalProfile = canonicalizeProfile(profile);
  await assertEntityCertification(env, canonicalProfile);
  const signerAddress = getSignerAddress(env, signerId)?.toLowerCase() ?? '';
  // Select authority by its exact board alias, then bind that alias to the
  // locally recovered EOA below. Matching by EOA here would erase the signed
  // alias and recreate the restore divergence this manifest is meant to stop.
  const validator = boardValidatorFor(canonicalProfile, signerId);
  if (!validator) {
    throw new Error(`PROFILE_ROUTE_SIGNER_NOT_ON_BOARD: entity=${profile.entityId} signerId=${signerId}`);
  }
  const signerPublicKey = getSignerPublicKey(env, signerId);
  const publicKeyHex = signerPublicKey ? `0x${Buffer.from(signerPublicKey).toString('hex')}`.toLowerCase() : '';
  if (!signerAddress || signerAddress.toLowerCase() !== validator.signer || publicKeyHex !== validator.publicKey) {
    throw new Error(`PROFILE_ROUTE_SIGNER_IDENTITY_MISMATCH: entity=${profile.entityId} signerId=${signerId}`);
  }
  const { runtimeSignature: _previousSignature, ...withoutRuntimeSignature } = canonicalProfile;
  const unsigned = canonicalizeProfile({ ...withoutRuntimeSignature, runtimeSignerId: validator.signerId });
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

const verifyRuntimeRouteSignature = (profile: Profile): ProfileVerifyResult => {
  const signerId = String(profile.runtimeSignerId || '').trim().toLowerCase();
  const signature = String(profile.runtimeSignature || '').trim().toLowerCase();
  const validator = boardValidatorFor(profile, signerId);
  if (!signerId || !validator) return { valid: false, reason: 'runtime_signer_not_on_board', signerId };
  if (!hasCanonicalRouteSignature(signature)) return { valid: false, reason: 'runtime_signature_non_canonical', signerId };
  const hash = computeProfileRouteHash(profile);
  if (recoverAddress(hash, signature).toLowerCase() !== validator.signer) {
    return { valid: false, reason: 'runtime_signature_invalid', hash, signerId };
  }
  return { valid: true, hash, signerId };
};

export async function verifyProfileSignature(profile: Profile, env?: Env): Promise<ProfileVerifyResult> {
  const canonicalProfile = canonicalizeProfile(profile);
  const hash = computeProfileHash(canonicalProfile);
  const hanko = canonicalProfile.metadata.profileHanko as HankoString | undefined;
  if (!hanko) return { valid: false, reason: 'entity_certification_missing', hash };
  let registeredBoardHash: string | null = null;
  if (env && canonicalProfile.metadata.jurisdiction) {
    registeredBoardHash = resolveProfileCertifiedBoardHash(env, canonicalProfile);
  }
  const entityResult = await verifyHankoForHash(
    hanko,
    hash,
    canonicalProfile.entityId,
    env,
    registeredBoardHash ? { registeredBoardHash } : undefined,
  );
  if (!entityResult.valid) return { valid: false, reason: 'entity_certification_invalid', hash };
  return verifyRuntimeRouteSignature(canonicalProfile);
}

export const hasValidProfileSignature = (profile: Profile): boolean =>
  Boolean(profile.metadata.profileHanko && profile.runtimeSignerId && profile.runtimeSignature);
