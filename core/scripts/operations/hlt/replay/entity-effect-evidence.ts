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
  'AccountSettledFinalizedBilateral',
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

const swapMatchedEffect = (entry: FrameLogEntry, index: number): Record<string, unknown> => {
  const data = requireBoundaryRecord(entry.data, `HLT_ENTITY_EFFECT_SWAP_MATCHED_INVALID:${index}`);
  requireExactBoundaryKeys(
    data,
    ['entityId', 'count'],
    [],
    `HLT_ENTITY_EFFECT_SWAP_MATCHED_FIELDS_INVALID:${index}`,
  );
  const entityId = String(data['entityId'] ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(entityId)) {
    throw new Error(`HLT_ENTITY_EFFECT_SWAP_MATCHED_ENTITY_INVALID:${index}`);
  }
  const count = requireBoundaryInteger(data['count'], `HLT_ENTITY_EFFECT_SWAP_MATCHED_COUNT_INVALID:${index}`);
  if (count < 1) throw new Error(`HLT_ENTITY_EFFECT_SWAP_MATCHED_COUNT_INVALID:${index}`);
  return { kind: 'swapMatched', entityId, count };
};

const projectEntityEffects = (logs: readonly FrameLogEntry[]): readonly Record<string, unknown>[] => {
  const effects: Record<string, unknown>[] = [];
  logs.forEach((entry, index) => {
    if (!ENTITY_EFFECT_EVENT_NAMES.has(entry.message)) return;
    if (entry.message !== 'SwapMatched') {
      throw new Error(`HLT_ENTITY_EFFECT_KIND_OUT_OF_SCOPE:${entry.message}:${index}`);
    }
    effects.push(swapMatchedEffect(entry, index));
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
