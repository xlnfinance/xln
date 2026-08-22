/** Deterministic, evenly spaced mainnet-like HLT operation schedule. */

import { requireBoundaryInteger } from '../../../../protocol/boundary-validation';

export type PacedOperation = Readonly<{
  ordinal: number;
  round: number;
  participantIndex: number;
  dueOffsetMs: number;
}>;

const greatestCommonDivisor = (left: number, right: number): number => {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
};

const coprimeStride = (participants: number, round: number): number => {
  let stride = (2_654_435_761 + round * 2_000_033) % participants;
  if (stride < 1) stride = 1;
  while (greatestCommonDivisor(stride, participants) !== 1) stride += 1;
  return stride;
};

const phaseShiftSlots = (
  participants: number,
  round: number,
  cadenceMs: number,
  jitterWindowMs: number,
): number => {
  const halfWindowMs = Math.min(cadenceMs / 2, jitterWindowMs / 2);
  const radius = Math.floor(halfWindowMs * participants / cadenceMs);
  if (radius === 0) return 0;
  const mixed = Math.imul(round + 1, 1_000_003) ^ Math.imul(round + 17, 2_654_435_761);
  return (Math.abs(mixed) % (radius * 2 + 1)) - radius;
};

const roundSchedule = (
  participants: number,
  round: number,
  cadenceMs: number,
  jitterWindowMs: number,
): PacedOperation[] => {
  const stride = coprimeStride(participants, round);
  const shift = phaseShiftSlots(participants, round, cadenceMs, jitterWindowMs);
  return Array.from({ length: participants }, (_, participantIndex) => {
    const slot = ((participantIndex * stride + shift) % participants + participants) % participants;
    return {
      ordinal: round * participants + slot,
      round,
      participantIndex,
      dueOffsetMs: round * cadenceMs + slot * cadenceMs / participants,
    };
  }).sort((left, right) => left.dueOffsetMs - right.dueOffsetMs);
};

export const buildPacedOperationSchedule = (options: {
  participants: number;
  rounds: number;
  cadenceMs: number;
  jitterWindowMs?: number;
}): PacedOperation[] => {
  const participants = requireBoundaryInteger(options.participants, 'HLT_PACER_PARTICIPANTS_INVALID', 1);
  const rounds = requireBoundaryInteger(options.rounds, 'HLT_PACER_ROUNDS_INVALID', 1);
  const cadenceMs = requireBoundaryInteger(options.cadenceMs, 'HLT_PACER_CADENCE_INVALID', 1);
  const jitterWindowMs = requireBoundaryInteger(options.jitterWindowMs ?? 500, 'HLT_PACER_JITTER_INVALID', 0);
  return Array.from({ length: rounds }, (_, round) =>
    roundSchedule(participants, round, cadenceMs, jitterWindowMs)).flat();
};
