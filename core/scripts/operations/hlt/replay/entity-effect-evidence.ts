import { sha256 } from '@noble/hashes/sha2.js';

import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../protocol/boundary-validation';
import { encodeCanonicalConsensusBytes } from '../../../../protocol/serialization/binary-codec';
import { Buffer } from '../../../../support/platform-crypto';
import type { FrameLogEntry } from '../../../../types/logging';

const ENTITY_EFFECTS_PARITY_DOMAIN = Buffer.from('xln.rscore.entity-effects-parity.v1', 'utf8');
const ENTITY_EFFECT_EVENT_NAMES = new Set([
  'account_settled_finalized_bilateral',
  'HtlcInitiated',
  'HtlcForwardAccepted',
  'HtlcFailed',
  'HtlcReceived',
  'HtlcFinalized',
  'SwapMatched',
]);

export type HltEntityEffectEvidence = Readonly<{
  runtimeHeight: number;
  effectCount: number;
  orderedEffectDigest: string;
}>;

const requireText = (data: Record<string, unknown>, field: string, code: string): string => {
  const value = data[field];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${code}:${field}`);
  return value;
};

const requireEntityId = (data: Record<string, unknown>, field: string, code: string): string => {
  const value = requireText(data, field, code).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value)) throw new Error(`${code}:${field}`);
  return value;
};

const requireHex32 = (data: Record<string, unknown>, field: string, code: string): string => {
  const value = requireText(data, field, code).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value)) throw new Error(`${code}:${field}`);
  return value;
};

const requireDecimal = (data: Record<string, unknown>, field: string, code: string): string => {
  const value = requireText(data, field, code);
  if (!/^(0|-?[1-9][0-9]*)$/.test(value)) throw new Error(`${code}:${field}`);
  return value;
};

const requireTokenId = (data: Record<string, unknown>, field: string, code: string): number => {
  const value = requireBoundaryInteger(data[field], `${code}:${field}`);
  if (value > 0xffff) throw new Error(`${code}:${field}`);
  return value;
};

const optionalText = (data: Record<string, unknown>, field: string, code: string): string | undefined => {
  if (!Object.hasOwn(data, field)) return undefined;
  return requireText(data, field, code);
};

const optionalHex32 = (data: Record<string, unknown>, field: string, code: string): string | undefined => {
  if (!Object.hasOwn(data, field)) return undefined;
  return requireHex32(data, field, code);
};

const optionalDecimal = (data: Record<string, unknown>, field: string, code: string): string | undefined => {
  if (!Object.hasOwn(data, field)) return undefined;
  return requireDecimal(data, field, code);
};

const optionalTokenId = (data: Record<string, unknown>, field: string, code: string): number | undefined => {
  if (!Object.hasOwn(data, field)) return undefined;
  return requireTokenId(data, field, code);
};

const eventData = (
  entry: FrameLogEntry,
  index: number,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> => {
  const code = `HLT_ENTITY_EFFECT_${entry.message.toUpperCase()}_INVALID:${index}`;
  const data = requireBoundaryRecord(entry.data, code);
  requireExactBoundaryKeys(data, required, optional, code);
  return data;
};

const accountSettledEffect = (entry: FrameLogEntry, index: number): Record<string, unknown> => {
  const data = eventData(entry, index, ['entityId', 'accountId', 'tokenId', 'jHeight', 'collateral', 'ondelta']);
  const code = `HLT_ENTITY_EFFECT_ACCOUNT_SETTLED_INVALID:${index}`;
  return {
    kind: 'runtimeEvent',
    eventName: entry.message,
    data: {
      entityId: requireEntityId(data, 'entityId', code),
      accountId: requireEntityId(data, 'accountId', code),
      tokenId: requireTokenId(data, 'tokenId', code),
      jHeight: requireBoundaryInteger(data['jHeight'], `${code}:jHeight`),
      collateral: requireDecimal(data, 'collateral', code),
      ondelta: requireDecimal(data, 'ondelta', code),
    },
  };
};

const htlcInitiatedEffect = (entry: FrameLogEntry, index: number): Record<string, unknown> => {
  const data = eventData(entry, index,
    ['entityId', 'fromEntity', 'toEntity', 'tokenId', 'amount', 'senderAmount', 'fee', 'hashlock', 'lockId', 'route', 'startedAtMs'],
    ['description']);
  const code = `HLT_ENTITY_EFFECT_HTLC_INITIATED_INVALID:${index}`;
  if (!Array.isArray(data['route']) || data['route'].length < 2) throw new Error(`${code}:route`);
  return {
    kind: 'htlcInitiated',
    entityId: requireEntityId(data, 'entityId', code),
    fromEntity: requireEntityId(data, 'fromEntity', code),
    toEntity: requireEntityId(data, 'toEntity', code),
    tokenId: requireTokenId(data, 'tokenId', code),
    amount: requireDecimal(data, 'amount', code),
    senderAmount: requireDecimal(data, 'senderAmount', code),
    fee: requireDecimal(data, 'fee', code),
    hashlock: requireHex32(data, 'hashlock', code),
    lockId: requireHex32(data, 'lockId', code),
    route: data['route'].map((value, routeIndex) => requireEntityId({ value }, 'value', `${code}:route=${routeIndex}`)),
    ...(optionalText(data, 'description', code) === undefined ? {} : { description: optionalText(data, 'description', code) }),
    startedAtMs: requireBoundaryInteger(data['startedAtMs'], `${code}:startedAtMs`),
  };
};

const htlcForwardAcceptedEffect = (entry: FrameLogEntry, index: number): Record<string, unknown> => {
  const data = eventData(entry, index, ['entityId', 'hashlock']);
  const code = `HLT_ENTITY_EFFECT_HTLC_FORWARD_ACCEPTED_INVALID:${index}`;
  return {
    kind: 'htlcForwardAccepted',
    entityId: requireEntityId(data, 'entityId', code),
    hashlock: requireHex32(data, 'hashlock', code),
  };
};

const htlcFailedEffect = (entry: FrameLogEntry, index: number): Record<string, unknown> => {
  const data = eventData(entry, index, ['entityId', 'hashlock', 'reason'], ['lockId']);
  const code = `HLT_ENTITY_EFFECT_HTLC_FAILED_INVALID:${index}`;
  const lockId = optionalHex32(data, 'lockId', code);
  return {
    kind: 'htlcFailed',
    entityId: requireEntityId(data, 'entityId', code),
    hashlock: requireHex32(data, 'hashlock', code),
    ...(lockId === undefined ? {} : { lockId }),
    reason: requireText(data, 'reason', code),
  };
};

const requireTerminalTiming = (
  data: Record<string, unknown>,
  terminalField: 'receivedAtMs' | 'finalizedAtMs',
  code: string,
): Record<string, number> => {
  const terminalAtMs = requireBoundaryInteger(data[terminalField], `${code}:${terminalField}`);
  if (!Object.hasOwn(data, 'startedAtMs')) return { [terminalField]: terminalAtMs };
  const startedAtMs = requireBoundaryInteger(data['startedAtMs'], `${code}:startedAtMs`);
  const elapsedMs = Math.max(1, terminalAtMs - startedAtMs);
  if (data['elapsedMs'] !== elapsedMs) throw new Error(`${code}:elapsedMs`);
  if (terminalField === 'finalizedAtMs' && data['finalizedInMs'] !== elapsedMs) {
    throw new Error(`${code}:finalizedInMs`);
  }
  return terminalField === 'finalizedAtMs'
    ? { startedAtMs, finalizedAtMs: terminalAtMs, elapsedMs, finalizedInMs: elapsedMs }
    : { startedAtMs, receivedAtMs: terminalAtMs, elapsedMs };
};

const htlcReceivedEffect = (entry: FrameLogEntry, index: number): Record<string, unknown> => {
  const data = eventData(entry, index,
    ['entityId', 'fromEntity', 'toEntity', 'hashlock', 'lockId', 'receivedAtMs'],
    ['amount', 'tokenId', 'jurisdictionId', 'description', 'startedAtMs', 'elapsedMs']);
  const code = `HLT_ENTITY_EFFECT_HTLC_RECEIVED_INVALID:${index}`;
  const amount = optionalDecimal(data, 'amount', code);
  const tokenId = optionalTokenId(data, 'tokenId', code);
  const jurisdictionId = optionalText(data, 'jurisdictionId', code);
  const description = optionalText(data, 'description', code);
  return {
    kind: 'htlcReceived',
    entityId: requireEntityId(data, 'entityId', code),
    fromEntity: requireEntityId(data, 'fromEntity', code),
    toEntity: requireEntityId(data, 'toEntity', code),
    hashlock: requireHex32(data, 'hashlock', code),
    lockId: requireHex32(data, 'lockId', code),
    ...(amount === undefined ? {} : { amount }),
    ...(tokenId === undefined ? {} : { tokenId }),
    ...(jurisdictionId === undefined ? {} : { jurisdictionId }),
    ...(description === undefined ? {} : { description }),
    ...requireTerminalTiming(data, 'receivedAtMs', code),
  };
};

const htlcFinalizedEffect = (entry: FrameLogEntry, index: number): Record<string, unknown> => {
  const data = eventData(entry, index, ['entityId', 'fromEntity', 'hashlock', 'finalizedAtMs'],
    ['toEntity', 'secret', 'lockId', 'amount', 'tokenId', 'jurisdictionId', 'description', 'startedAtMs', 'elapsedMs', 'finalizedInMs']);
  const code = `HLT_ENTITY_EFFECT_HTLC_FINALIZED_INVALID:${index}`;
  const toEntity = Object.hasOwn(data, 'toEntity') ? requireEntityId(data, 'toEntity', code) : undefined;
  const secret = optionalHex32(data, 'secret', code);
  const lockId = optionalHex32(data, 'lockId', code);
  const amount = optionalDecimal(data, 'amount', code);
  const tokenId = optionalTokenId(data, 'tokenId', code);
  const jurisdictionId = optionalText(data, 'jurisdictionId', code);
  const description = optionalText(data, 'description', code);
  return {
    kind: 'htlcFinalized',
    entityId: requireEntityId(data, 'entityId', code),
    fromEntity: requireEntityId(data, 'fromEntity', code),
    ...(toEntity === undefined ? {} : { toEntity }),
    hashlock: requireHex32(data, 'hashlock', code),
    ...(secret === undefined ? {} : { secret }),
    ...(lockId === undefined ? {} : { lockId }),
    ...(amount === undefined ? {} : { amount }),
    ...(tokenId === undefined ? {} : { tokenId }),
    ...(jurisdictionId === undefined ? {} : { jurisdictionId }),
    ...(description === undefined ? {} : { description }),
    ...requireTerminalTiming(data, 'finalizedAtMs', code),
  };
};

const swapMatchedEffect = (entry: FrameLogEntry, index: number): Record<string, unknown> => {
  const data = eventData(entry, index, ['entityId', 'count']);
  const code = `HLT_ENTITY_EFFECT_SWAP_MATCHED_INVALID:${index}`;
  const count = requireBoundaryInteger(data['count'], `HLT_ENTITY_EFFECT_SWAP_MATCHED_COUNT_INVALID:${index}`);
  if (count < 1) throw new Error(`HLT_ENTITY_EFFECT_SWAP_MATCHED_COUNT_INVALID:${index}`);
  return { kind: 'swapMatched', entityId: requireEntityId(data, 'entityId', code), count };
};

const projectEntityEffect = (entry: FrameLogEntry, index: number): Record<string, unknown> => {
  switch (entry.message) {
    case 'account_settled_finalized_bilateral': return accountSettledEffect(entry, index);
    case 'HtlcInitiated': return htlcInitiatedEffect(entry, index);
    case 'HtlcForwardAccepted': return htlcForwardAcceptedEffect(entry, index);
    case 'HtlcFailed': return htlcFailedEffect(entry, index);
    case 'HtlcReceived': return htlcReceivedEffect(entry, index);
    case 'HtlcFinalized': return htlcFinalizedEffect(entry, index);
    case 'SwapMatched': return swapMatchedEffect(entry, index);
    default: throw new Error(`HLT_ENTITY_EFFECT_KIND_OUT_OF_SCOPE:${entry.message}:${index}`);
  }
};

const projectEntityEffects = (logs: readonly FrameLogEntry[]): readonly Record<string, unknown>[] => {
  const effects: Record<string, unknown>[] = [];
  logs.forEach((entry, index) => {
    if (!ENTITY_EFFECT_EVENT_NAMES.has(entry.message)) return;
    effects.push(projectEntityEffect(entry, index));
  });
  return effects;
};

export const buildHltEntityEffectEvidence = (
  runtimeHeight: number,
  logs: readonly FrameLogEntry[],
): HltEntityEffectEvidence => {
  const effects = projectEntityEffects(logs);
  const digest = sha256.create();
  digest.update(ENTITY_EFFECTS_PARITY_DOMAIN);
  digest.update(encodeCanonicalConsensusBytes(effects));
  return {
    runtimeHeight,
    effectCount: effects.length,
    orderedEffectDigest: `0x${Buffer.from(digest.digest()).toString('hex')}`,
  };
};
