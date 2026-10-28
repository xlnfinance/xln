import { expect, test } from 'bun:test';
import { safeStringify } from '../../../../protocol/serialization';
import { executeLendingEdges } from '../../../../../rscore/fixtures/account-semantics/lending-edges';
import { executeLendingBookVectors } from '../../../../../rscore/fixtures/entity-kernel/lending';
import { executeLendingServicingVectors } from '../../../../../rscore/fixtures/entity-kernel/lending-servicing';

// Pin the exact pre-existing oracle bytes while Rust generates its TS oracle at test time.
const oracleDigest = (value: unknown): string =>
  new Bun.CryptoHasher('sha256').update(`${safeStringify(value, 2)}\n`).digest('hex');

test('production TS lending edges reproduce the Rust differential oracle', async () => {
  const actual = await executeLendingEdges();
  expect(oracleDigest(actual)).toBe('c83f0891421f575c5998c0e2d5639bf3eee0e3a1f1f41f363af062f4a9d31779');
  expect(new Set(actual.cases.flatMap(row => row.steps.map(step => step.txType))).size).toBe(7);
});

test('production TS bank commands, lifecycle and snapshots reproduce the Rust oracle', async () => {
  expect(oracleDigest(await executeLendingBookVectors())).toBe('8be74ded2d8f5f6ee9a4a6ab7a9cdbdaa174ffd4adfefe481ef88fb6d6162575');
});

test('production TS withdrawal, renewal, finality and API projections reproduce the Rust oracle', async () => {
  expect(oracleDigest(await executeLendingServicingVectors())).toBe('46d4bd6f0872e0fde89197a0b127a073975e8f1db8e35a9d69296ababbf3ae65');
});
