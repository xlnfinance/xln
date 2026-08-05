/**
 * Why a pull commitment may be revealed at exactly one fill level.
 *
 * A nibble reveal for digit d is H^(15-d)(base), so a higher digit derives
 * every lower one by hashing. Fill ratios can rise while individual nibbles
 * fall (0x0FFF -> 0x1000), so an observer of two authorized reveals holds the
 * nibble-wise maximum of both — strictly more than either level granted.
 *
 * The dispute path has no defence: DeltaTransformer.verifiedPullFillRatio
 * checks only the ladder math against partialRoot and knows nothing about the
 * committed fill level. Both legs of a cross-j order share one commitment, so
 * per-level reveals on the source leg would arm this over-claim against the
 * target-leg payer. Settlement therefore stays single-shot: one close, at the
 * level the counterparty asked for or at a full fill.
 */
import { describe, expect, test } from 'bun:test';

import {
  buildHashLadderProof,
  decodeHashLadderBinary,
  encodeHashLadderPartialBinary,
  revealHashLadder,
  verifyHashLadderBinary,
} from '../protocol/htlc/hash-ladder';

describe('hash ladder is single-shot per commitment', () => {
  test('two authorized reveals forge a higher ratio; one reveal forges nothing', () => {
    const proof = buildHashLadderProof('ladder-single-shot-test');
    const commitment = { fullHash: proof.fullHash, partialRoot: proof.partialRoot };
    const lower = 0x0fff;
    const higher = 0x1000;
    const forged = 0x1fff;

    const revealsLower = decodeHashLadderBinary(revealHashLadder(proof, lower).binary).reveals!;
    const revealsHigher = decodeHashLadderBinary(revealHashLadder(proof, higher).binary).reveals!;

    // Nibble 0 comes from the higher level, nibbles 1-3 from the lower one.
    const combined = encodeHashLadderPartialBinary(forged, [
      revealsHigher[0]!, revealsLower[1]!, revealsLower[2]!, revealsLower[3]!,
    ]);
    expect(verifyHashLadderBinary(commitment, combined).fillRatio).toBe(forged);
    expect(forged).toBeGreaterThan(higher);
    // 0x1FFF - 0x1000 = 4095/65535, i.e. 6.25% of the pull notional.
    expect(forged - higher).toBe(0x0fff);

    const soloForge = encodeHashLadderPartialBinary(forged, revealsHigher);
    expect(() => verifyHashLadderBinary(commitment, soloForge)).toThrow();
  });
});
