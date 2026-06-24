/**
 * Pure push-registration message builders and owner-signature verification.
 *
 * Mirrors the watchtower appointment trust model: the owner signs a
 * domain-separated message with their root signer and the server recovers it,
 * requiring recovered address === runtimeId. No keys are ever held server-side.
 */

import { ethers } from 'ethers';
import type {
  PushPlatformV1,
  PushRegistrationRequestV1,
  PushUnregisterRequestV1,
  StoredPushRegistration,
} from './types';

const PUSH_REGISTRATION_DOMAIN = 'xln:push:register:v1';
const PUSH_UNREGISTER_DOMAIN = 'xln:push:unregister:v1';
const VALID_PLATFORMS: ReadonlySet<PushPlatformV1> = new Set(['ios', 'android', 'web', 'desktop']);
const MAX_TOKEN_LENGTH = 4096;
const MAX_RPC_URL_LENGTH = 512;

export const PUSH_REGISTRATION_MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

export const hashPushToken = (token: string): string =>
  ethers.keccak256(ethers.toUtf8Bytes(String(token || ''))).toLowerCase();

const normalizeRuntimeId = (value: unknown): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!ethers.isAddress(normalized)) throw new Error('PUSH_RUNTIME_ID_INVALID');
  return normalized;
};

const normalizeEntityId = (value: unknown): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error('PUSH_ENTITY_ID_INVALID');
  return normalized;
};

const normalizeAddress = (value: unknown): string => {
  const raw = String(value || '').trim();
  if (!ethers.isAddress(raw)) throw new Error('PUSH_DEPOSITORY_INVALID');
  return raw.toLowerCase();
};

const normalizePlatform = (value: unknown): PushPlatformV1 => {
  const normalized = String(value || '').trim().toLowerCase() as PushPlatformV1;
  if (!VALID_PLATFORMS.has(normalized)) throw new Error('PUSH_PLATFORM_INVALID');
  return normalized;
};

const normalizeToken = (value: unknown): string => {
  const token = String(value || '').trim();
  if (!token || token.length > MAX_TOKEN_LENGTH) throw new Error('PUSH_TOKEN_INVALID');
  return token;
};

const normalizeChainId = (value: unknown): number => {
  const chainId = Math.floor(Number(value));
  if (!Number.isFinite(chainId) || chainId <= 0) throw new Error('PUSH_CHAIN_ID_INVALID');
  return chainId;
};

const normalizeRpcUrl = (value: unknown): string => {
  const rpcUrl = String(value || '').trim();
  if (!rpcUrl || rpcUrl.length > MAX_RPC_URL_LENGTH || !/^https?:\/\//i.test(rpcUrl)) {
    throw new Error('PUSH_RPC_URL_INVALID');
  }
  return rpcUrl;
};

const normalizeSignedAt = (value: unknown): number => {
  const signedAt = Math.floor(Number(value));
  if (!Number.isFinite(signedAt) || signedAt <= 0) throw new Error('PUSH_SIGNED_AT_INVALID');
  return signedAt;
};

const assertFresh = (signedAt: number, options?: { now?: number; maxClockSkewMs?: number }): void => {
  if (options?.now === undefined) return;
  const maxSkew = Math.max(0, Math.floor(Number(options.maxClockSkewMs ?? PUSH_REGISTRATION_MAX_CLOCK_SKEW_MS)));
  if (Math.abs(options.now - signedAt) > maxSkew) throw new Error('PUSH_REQUEST_STALE');
};

export const buildPushRegistrationMessage = (
  runtimeId: string,
  entityId: string,
  tokenHash: string,
  platform: PushPlatformV1,
  chainId: number,
  depositoryAddress: string,
  signedAt: number,
): string =>
  `${PUSH_REGISTRATION_DOMAIN}|${runtimeId.toLowerCase()}|${entityId.toLowerCase()}|${tokenHash.toLowerCase()}|${platform}|${Math.floor(chainId)}|${depositoryAddress.toLowerCase()}|${Math.floor(signedAt)}`;

export const buildPushUnregisterMessage = (runtimeId: string, tokenHash: string, signedAt: number): string =>
  `${PUSH_UNREGISTER_DOMAIN}|${runtimeId.toLowerCase()}|${tokenHash.toLowerCase()}|${Math.floor(signedAt)}`;

export const verifyPushRegistration = (
  request: PushRegistrationRequestV1,
  options?: { now?: number; maxClockSkewMs?: number },
): StoredPushRegistration => {
  if (!request || request.type !== 'push_registration' || request.version !== 1) {
    throw new Error('PUSH_REGISTRATION_INVALID');
  }
  const runtimeId = normalizeRuntimeId(request.runtimeId);
  const entityId = normalizeEntityId(request.entityId);
  const token = normalizeToken(request.token);
  const platform = normalizePlatform(request.platform);
  const chainId = normalizeChainId(request.chainId);
  const depositoryAddress = normalizeAddress(request.depositoryAddress);
  const rpcUrl = normalizeRpcUrl(request.rpcUrl);
  const signedAt = normalizeSignedAt(request.signedAt);
  assertFresh(signedAt, options);
  const tokenHash = hashPushToken(token);
  const message = buildPushRegistrationMessage(
    runtimeId,
    entityId,
    tokenHash,
    platform,
    chainId,
    depositoryAddress,
    signedAt,
  );
  const recovered = ethers.verifyMessage(message, String(request.ownerSignature || '')).toLowerCase();
  if (recovered !== runtimeId) {
    throw new Error(`PUSH_REGISTRATION_SIGNATURE_INVALID: recovered=${recovered} expected=${runtimeId}`);
  }
  return {
    runtimeId,
    entityId,
    tokenHash,
    token,
    platform,
    chainId,
    depositoryAddress,
    rpcUrl,
    signedAt,
    updatedAt: 0,
  };
};

export const verifyPushUnregister = (
  request: PushUnregisterRequestV1,
  options?: { now?: number; maxClockSkewMs?: number },
): { runtimeId: string; tokenHash: string } => {
  if (!request || request.type !== 'push_unregister' || request.version !== 1) {
    throw new Error('PUSH_UNREGISTER_INVALID');
  }
  const runtimeId = normalizeRuntimeId(request.runtimeId);
  const token = normalizeToken(request.token);
  const signedAt = normalizeSignedAt(request.signedAt);
  assertFresh(signedAt, options);
  const tokenHash = hashPushToken(token);
  const message = buildPushUnregisterMessage(runtimeId, tokenHash, signedAt);
  const recovered = ethers.verifyMessage(message, String(request.ownerSignature || '')).toLowerCase();
  if (recovered !== runtimeId) {
    throw new Error(`PUSH_UNREGISTER_SIGNATURE_INVALID: recovered=${recovered} expected=${runtimeId}`);
  }
  return { runtimeId, tokenHash };
};
