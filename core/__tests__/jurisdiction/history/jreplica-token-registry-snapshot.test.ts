import { expect, test } from 'bun:test';

import { validateJReplicas } from '../../../storage/wal/runtime-machine-schema/j';
import { buildCanonicalJReplicaSnapshot } from '../../../storage/wal/snapshot';
import { createTestJReplica } from '../../helpers/j-replica';

// Same-J matching reads token dimensions from the J replica inside the Entity transition and
// halts without them. A checkpoint that dropped the registry stopped every restarted hub on
// its first swap offer.
test('a checkpointed J replica keeps the token registry that same-J matching reads', () => {
  const tokenRegistry = [{
    symbol: 'USDC', name: 'USD Coin', address: `0x${'aa'.repeat(20)}`,
    decimals: 6, tokenId: 1, tokenType: 0 as const, externalTokenId: 0n,
  }];
  const snapshot = buildCanonicalJReplicaSnapshot(createTestJReplica({ name: 'Testnet', chainId: 31337, tokenRegistry }));
  expect(snapshot.tokenRegistry).toEqual(tokenRegistry);
  expect(snapshot.tokenRegistry).not.toBe(tokenRegistry);
  const [[, decoded]] = validateJReplicas([['Testnet', snapshot]], 'J_REPLICAS');
  expect(decoded.tokenRegistry).toEqual(tokenRegistry);
  expect(() => validateJReplicas(
    [['Testnet', { ...snapshot, tokenRegistry: [{ ...tokenRegistry[0], decimals: '6' }] }]],
    'J_REPLICAS',
  )).toThrow();
});
