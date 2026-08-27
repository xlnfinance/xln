import { LIMITS } from '../../config/constants';
import {
  canonicalEntityCommandBoardEpoch,
  canonicalEntityCommandBytes32,
  canonicalEntityCommandSignerId,
} from '../../entity/command/command-codec';
import type { EntityCommandNonceState } from '../../types/entity-tx';
import { compareStableText } from '../../protocol/serialization';
import type { RscoreWireValue } from '../client';
import { hexToWireBytes } from '../shadow-wire';

/** Exact optional wire image of the bounded Entity command retry fence. */
export const entityCommandNoncesWire = (
  state: EntityCommandNonceState | undefined,
): RscoreWireValue[] | null => {
  if (state === undefined) return null;
  if (state.version !== 1 || !(state.bySigner instanceof Map)) {
    throw new Error('RSCORE_ENTITY_COMMAND_NONCES_INVALID');
  }
  if (state.bySigner.size > LIMITS.MAX_VALIDATORS) {
    throw new Error(`RSCORE_ENTITY_COMMAND_NONCES_OVERSIZED:${state.bySigner.size}`);
  }
  const bySigner = [...state.bySigner.entries()]
    .map(([rawSignerId, record]) => {
      const signerId = canonicalEntityCommandSignerId(rawSignerId);
      if (signerId !== rawSignerId || record.nonce < 1n) {
        throw new Error(`RSCORE_ENTITY_COMMAND_NONCE_RECORD_INVALID:${rawSignerId}`);
      }
      return [
        signerId,
        record.nonce.toString(),
        hexToWireBytes(
          canonicalEntityCommandBytes32(
            record.commandHash,
            'RSCORE_ENTITY_COMMAND_HASH_INVALID',
          ),
          32,
          'RSCORE_ENTITY_COMMAND_HASH',
        ),
      ] satisfies RscoreWireValue[];
    })
    .sort((left, right) => compareStableText(String(left[0]), String(right[0])));
  return [
    1,
    hexToWireBytes(
      canonicalEntityCommandBytes32(
        state.boardHash,
        'RSCORE_ENTITY_COMMAND_BOARD_HASH_INVALID',
      ),
      32,
      'RSCORE_ENTITY_COMMAND_BOARD_HASH',
    ),
    canonicalEntityCommandBoardEpoch(state.boardEpoch),
    bySigner,
  ];
};
