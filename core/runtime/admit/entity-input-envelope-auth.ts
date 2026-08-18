import { keccakTextHash } from '../../protocol/crypto/keccak-text';

import { getSignerAddress, signAccountFrame, verifyAccountSignature } from '../../account/crypto.ts';
import { normalizeRuntimeId } from '../../network/p2p/auth/runtime-id.ts';
import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';
import type {
  RuntimeEntityInputsEnvelope,
  RuntimeReplica,
  UnsignedRuntimeEntityInputsEnvelope,
} from '../types.ts';

const ENVELOPE_SIGNATURE_DOMAIN = 'xln.runtime.entity-inputs-envelope.v1';

const unsignedEnvelope = (
  envelope: RuntimeEntityInputsEnvelope,
): UnsignedRuntimeEntityInputsEnvelope => {
  const { sourceSignature: _sourceSignature, ...body } = envelope;
  return body;
};

const hashRuntimeEntityInputsEnvelope = (
  targetRuntimeIdRaw: string,
  body: UnsignedRuntimeEntityInputsEnvelope,
): string => {
  const targetRuntimeId = normalizeRuntimeId(targetRuntimeIdRaw);
  if (!targetRuntimeId) throw new Error('RUNTIME_ENTITY_INPUTS_TARGET_RUNTIME_INVALID');
  return keccakTextHash(encodeCanonicalConsensusValue([
    ENVELOPE_SIGNATURE_DOMAIN,
    targetRuntimeId,
    body,
  ]));
};

export const signRuntimeEntityInputsEnvelope = (
  env: RuntimeReplica,
  targetRuntimeId: string,
  body: UnsignedRuntimeEntityInputsEnvelope,
): RuntimeEntityInputsEnvelope => {
  const sourceRuntimeId = normalizeRuntimeId(body.sourceRuntimeId);
  const ownerRuntimeId = normalizeRuntimeId(getSignerAddress(env, '1'));
  if (!sourceRuntimeId || sourceRuntimeId !== ownerRuntimeId || sourceRuntimeId !== normalizeRuntimeId(env.runtimeId)) {
    throw new Error('RUNTIME_ENTITY_INPUTS_SOURCE_OWNER_MISMATCH');
  }
  const canonicalBody = { ...body, sourceRuntimeId };
  return {
    ...canonicalBody,
    sourceSignature: signAccountFrame(
      env,
      '1',
      hashRuntimeEntityInputsEnvelope(targetRuntimeId, canonicalBody),
    ).toLowerCase(),
  };
};

export const assertRuntimeEntityInputsEnvelopeSource = (
  env: RuntimeReplica,
  transportSourceRaw: string,
  envelope: RuntimeEntityInputsEnvelope,
): { sourceRuntimeId: string; localRuntimeId: string } => {
  const sourceRuntimeId = normalizeRuntimeId(envelope.sourceRuntimeId);
  const transportSource = normalizeRuntimeId(transportSourceRaw);
  const localRuntimeId = normalizeRuntimeId(env.runtimeId);
  if (!sourceRuntimeId || sourceRuntimeId !== transportSource) {
    throw new Error('INBOUND_ENTITY_INPUTS_SOURCE_RUNTIME_MISMATCH');
  }
  if (!localRuntimeId) throw new Error('INBOUND_ENTITY_INPUTS_TARGET_RUNTIME_INVALID');
  if (!verifyAccountSignature(
    { quietRuntimeLogs: true },
    sourceRuntimeId,
    hashRuntimeEntityInputsEnvelope(localRuntimeId, unsignedEnvelope(envelope)),
    envelope.sourceSignature,
  )) {
    throw new Error('INBOUND_ENTITY_INPUTS_SOURCE_SIGNATURE_INVALID');
  }
  return { sourceRuntimeId, localRuntimeId };
};
