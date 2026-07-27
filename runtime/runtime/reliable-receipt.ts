import { keccak256, toUtf8Bytes } from 'ethers';

import { signAccountFrame, verifyAccountSignature } from '../account/crypto';
import { normalizeRuntimeId } from '../networking/runtime-id';
import { serializeTaggedJson } from '../protocol/serialization';
import type {
  Env,
  ReliableDeliveryIdentity,
  ReliableDeliveryReceipt,
  RoutedEntityInput,
} from '../types';
import { getReliableIdentityValidationError } from './reliable-frontier';
import { getReliableOutputIdentity } from './output-routing';

export const ensureReliableState = (env: Env): NonNullable<Env['runtimeState']> => {
  env.runtimeState ??= {};
  return env.runtimeState;
};

const toDeliveryIdentity = (
  identity: NonNullable<ReturnType<typeof getReliableOutputIdentity>>,
): ReliableDeliveryIdentity => ({
  kind: identity.kind,
  entityId: identity.entityId,
  signerId: identity.signerId,
  laneKey: identity.laneKey,
  height: identity.height,
  ...(identity.logIndex !== undefined ? { logIndex: identity.logIndex } : {}),
  frameHash: identity.frameHash,
  logicalKey: identity.logicalKey,
  evidenceVersion: identity.evidenceVersion,
  evidenceKind: identity.evidenceKind,
  evidenceDigest: identity.evidenceDigest,
  ...(identity.bodyDigest ? { bodyDigest: identity.bodyDigest } : {}),
  ...(identity.evidenceBindings
    ? { evidenceBindings: identity.evidenceBindings.map(binding => ({ ...binding })) }
    : {}),
});

export const getInputReliableIdentity = (
  input: RoutedEntityInput,
): ReliableDeliveryIdentity | null => {
  const identity = getReliableOutputIdentity(input);
  return identity ? toDeliveryIdentity(identity) : null;
};

const receiptDigest = (body: ReliableDeliveryReceipt['body']): string =>
  keccak256(toUtf8Bytes(serializeTaggedJson(body))).toLowerCase();

export const createReliableDeliveryReceipt = (
  env: Env,
  identity: ReliableDeliveryIdentity,
  coverage: ReliableDeliveryReceipt['body']['coverage'],
): ReliableDeliveryReceipt => {
  const receiverRuntimeId = normalizeRuntimeId(env.runtimeId);
  if (!receiverRuntimeId) throw new Error('RELIABLE_RECEIPT_RECEIVER_RUNTIME_INVALID');
  if (!Number.isSafeInteger(env.height) || env.height < 0) {
    throw new Error(`RELIABLE_RECEIPT_RUNTIME_HEIGHT_INVALID:${String(env.height)}`);
  }
  const body: ReliableDeliveryReceipt['body'] = {
    version: 2,
    coverage,
    receiverRuntimeId,
    identity,
    appliedRuntimeHeight: env.height,
  };
  return { body, signature: signAccountFrame(env, receiverRuntimeId, receiptDigest(body)) };
};

export const getReliableDeliveryReceiptValidationError = (
  env: Env,
  receipt: ReliableDeliveryReceipt,
): string | null => {
  if (!receipt || typeof receipt !== 'object' || !receipt.body || typeof receipt.body !== 'object') {
    return 'RELIABLE_RECEIPT_BODY_INVALID';
  }
  const { body } = receipt;
  if (body.version !== 2) return 'RELIABLE_RECEIPT_VERSION_INVALID';
  if (body.coverage !== 'exact' && body.coverage !== 'terminal') {
    return 'RELIABLE_RECEIPT_COVERAGE_INVALID';
  }
  const receiverRuntimeId = normalizeRuntimeId(body.receiverRuntimeId);
  if (!receiverRuntimeId || receiverRuntimeId !== body.receiverRuntimeId) {
    return 'RELIABLE_RECEIPT_RECEIVER_RUNTIME_INVALID';
  }
  const identityError = getReliableIdentityValidationError(body.identity);
  if (identityError) return identityError;
  if (!Number.isSafeInteger(body.appliedRuntimeHeight) || body.appliedRuntimeHeight < 0) {
    return 'RELIABLE_RECEIPT_APPLIED_HEIGHT_INVALID';
  }
  if (typeof receipt.signature !== 'string') return 'RELIABLE_RECEIPT_SIGNATURE_INVALID';
  return verifyAccountSignature(env, receiverRuntimeId, receiptDigest(body), receipt.signature)
    ? null
    : 'RELIABLE_RECEIPT_SIGNATURE_INVALID';
};
