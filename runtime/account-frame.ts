import type { AccountFrame, Delta } from './types';

export const deriveAccountFrameOffdeltas = (frameOrDeltas: AccountFrame | readonly Delta[]): bigint[] => {
  const deltas: readonly Delta[] = Array.isArray(frameOrDeltas)
    ? frameOrDeltas
    : (frameOrDeltas as AccountFrame).deltas;
  return deltas.map((delta) => delta.offdelta);
};

export const deriveAccountFrameTokenIds = (frameOrDeltas: AccountFrame | readonly Delta[]): number[] => {
  const deltas: readonly Delta[] = Array.isArray(frameOrDeltas)
    ? frameOrDeltas
    : (frameOrDeltas as AccountFrame).deltas;
  return deltas.map((delta) => delta.tokenId);
};

export const assertAccountFrameDeltaIntegrity = (
  frame: AccountFrame,
  label = 'AccountFrame',
): void => {
  let previousTokenId = -1;
  for (let index = 0; index < frame.deltas.length; index += 1) {
    const delta = frame.deltas[index];
    if (!delta) throw new Error(`${label}: missing deltas[${index}]`);
    if (!Number.isInteger(delta.tokenId) || delta.tokenId < 0) {
      throw new Error(`${label}: deltas[${index}].tokenId must be a non-negative integer`);
    }
    if (delta.tokenId <= previousTokenId) {
      throw new Error(`${label}: deltas must be sorted by unique tokenId`);
    }
    if (typeof delta.offdelta !== 'bigint') {
      throw new Error(`${label}: deltas[${index}].offdelta must be bigint`);
    }
    previousTokenId = delta.tokenId;
  }
};
