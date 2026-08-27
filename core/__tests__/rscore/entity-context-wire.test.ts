import { expect, test } from 'bun:test';

import { entityDeterministicContextWire } from '../../rscore/entity/round-wire';
import type { EntityInfraContext } from '../../types/entity/infra-context';
import { addr, entity, makeJurisdiction, makeState } from '../helpers/cross-j';

test('prepared final context preserves its optional description on the Rust wire', () => {
  const owner = entity('a1');
  const peer = entity('b2');
  const signer = addr('c3');
  const jurisdiction = makeJurisdiction('prepared-description', 31_337, 'd4', 'e5');
  const state = makeState(owner, signer, jurisdiction);
  const frameHash = `0x${'11'.repeat(32)}`;
  const lockId = `0x${'22'.repeat(32)}`;
  const context: EntityInfraContext = {
    version: 1,
    proposerReplicaId: `${owner}:${signer}`,
    entityId: owner,
    proposerSignerId: signer,
    parentFrameHash: `0x${'33'.repeat(32)}`,
    height: 1,
    gossipProfiles: [],
    peerAssertions: [],
    htlc: {
      version: 1,
      entries: [{
        binding: {
          fromEntityId: peer,
          toEntityId: owner,
          domain: {
            chainId: 31_337,
            depositoryAddress: `0x${'44'.repeat(20)}`,
          },
          accountFrameHash: frameHash,
          accountHeight: 1,
          lockId,
          envelopeHash: `0x${'55'.repeat(32)}`,
          hashlock: `0x${'66'.repeat(32)}`,
          tokenId: 1,
          amount: 1_000n,
          timelock: 100_000n,
          revealBeforeHeight: 100,
        },
        outcome: {
          kind: 'final',
          secret: `0x${'77'.repeat(32)}`,
          description: 'canonical payment note',
          startedAtMs: 1_500,
        },
      }],
      originated: [],
    },
  };

  const wire = entityDeterministicContextWire(state, context, jurisdiction.name);
  const rows = wire[4] as unknown[][];
  expect(rows).toHaveLength(1);
  expect(rows[0]?.[1]).toEqual([
    1,
    Uint8Array.from({ length: 32 }, () => 0x77),
    'canonical payment note',
    1_500,
  ]);
});
