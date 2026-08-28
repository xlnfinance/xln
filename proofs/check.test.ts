import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { loadProofProgram, validateProofProgram } from './check';

const root = resolve(import.meta.dir, '..');

describe('proof-program manifest gate', () => {
  test('accepts the committed C1-C10 accountability manifest', () => {
    expect(validateProofProgram(loadProofProgram(root), root)).toEqual([]);
  });

  test('rejects a completion claim without current independent audits', () => {
    const program = structuredClone(loadProofProgram(root)) as { claims: Array<Record<string, unknown>> };
    program.claims[7]!.complete = true;
    expect(validateProofProgram(program, root)).toContain('C8: complete without current adversary audit');
    expect(validateProofProgram(program, root)).toContain('C8: complete without current repro audit');
  });

  test('rejects missing evidence and a missing claim', () => {
    const program = structuredClone(loadProofProgram(root)) as {
      claims: Array<Record<string, unknown>>;
      releaseClaimAllowed: boolean;
    };
    program.claims[0]!.evidence = ['proofs/not-real'];
    program.claims.pop();
    expect(validateProofProgram(program, root)).toContain('claims: expected 10, received 9');
    expect(validateProofProgram(program, root)).toContain('missing evidence path: proofs/not-real');
  });
});
