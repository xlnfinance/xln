import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CROSS_J_OPENING_VECTOR_SPECS,
  executeCrossJOpeningVector,
  type CrossJOpeningVectorResult,
  type CrossJOpeningVectorSpec,
} from '../../../../rscore/fixtures/cross-j-opening/cases';

type FixtureCase = CrossJOpeningVectorSpec & { expected: CrossJOpeningVectorResult };
type Fixture = Readonly<{
  version: number;
  canonicalSource: string;
  cases: readonly FixtureCase[];
}>;

const fixture = JSON.parse(readFileSync(
  join(import.meta.dir, '../../../../rscore/fixtures/cross-j-opening/parity-v1.json'),
  'utf8',
)) as Fixture;

describe('shared cross-J opening selector vectors', () => {
  test('checked-in cases are the complete TypeScript oracle inventory', () => {
    expect(fixture.version).toBe(1);
    expect(fixture.canonicalSource).toBe('TypeScript selectCrossJOpeningAccountProposalTxs');
    expect(fixture.cases.map(row => row.name)).toEqual(
      CROSS_J_OPENING_VECTOR_SPECS.map(row => row.name),
    );
  });

  for (const row of fixture.cases) {
    test(`${row.name} matches the checked-in selection and literal hashes`, () => {
      expect(executeCrossJOpeningVector(row)).toEqual(row.expected);
    });
  }
});
