import { describe, expect, test } from 'bun:test';

import { decodeTowerProofBody } from '../recovery/tower-proof-body';

const validProofBody = {
  watchSeed: `0x${'12'.repeat(32)}`,
  offdeltas: [-7n],
  tokenIds: [1n],
  transformers: [
    {
      transformerAddress: `0x${'34'.repeat(20)}`,
      encodedBatch: '0x1234',
      allowances: [
        {
          deltaIndex: 0n,
          rightAllowance: 5n,
          leftAllowance: 0n,
        },
      ],
    },
  ],
};

describe('watchtower proof-body boundary', () => {
  test('constructs an exact independent proof body', () => {
    const decoded = decodeTowerProofBody(validProofBody);

    expect(decoded).toEqual(validProofBody);
    expect(decoded).not.toBe(validProofBody);
    expect(decoded.transformers[0]).not.toBe(validProofBody.transformers[0]);
    expect(decoded.transformers[0]?.allowances[0]).not.toBe(
      validProofBody.transformers[0]?.allowances[0],
    );
  });

  test('rejects malformed persisted evidence before tower publication', () => {
    expect(() =>
      decodeTowerProofBody({
        ...validProofBody,
        offdeltas: ['-7'],
      }),
    ).toThrow('TOWER_PROOF_BODY_BIGINT_REQUIRED:offdeltas.0');
  });
});
