import { describe, expect, test } from 'bun:test';
import {
  collectRuntimeEntityContext,
  describeEntityInputCommitShape,
} from '../../../runtime/admit/entity-context-collection';
import type { EntityInfraContext } from '../../../types/entity/infra-context';

const makeContext = (online = true): EntityInfraContext => ({
  version: 1,
  proposerReplicaId: `0x${'aa'.repeat(32)}:signer-a`,
  entityId: `0x${'aa'.repeat(32)}`,
  proposerSignerId: 'signer-a',
  parentFrameHash: 'genesis',
  height: 1,
  gossipProfiles: [],
  peerAssertions: [{ entityId: `0x${'bb'.repeat(32)}`, online }],
  htlc: { version: 1, entries: [], originated: [] },
});

describe('Runtime Entity context collection', () => {
  test('keys a relayed frame by the receiving validator replica, not its proposer', () => {
    const contexts = new Map<string, EntityInfraContext>();
    collectRuntimeEntityContext(contexts, `0x${'aa'.repeat(32)}`, `0x${'aa'.repeat(32)}:signer-b`, makeContext());
    expect([...contexts.keys()]).toEqual([`0x${'aa'.repeat(32)}:signer-b:1`]);
  });

  test('records the same proposer context independently for two local sibling replicas', () => {
    const contexts = new Map<string, EntityInfraContext>();
    const entityId = `0x${'aa'.repeat(32)}`;
    collectRuntimeEntityContext(contexts, entityId, `${entityId}:signer-b`, makeContext());
    collectRuntimeEntityContext(contexts, entityId, `${entityId}:signer-c`, makeContext());
    expect([...contexts.keys()]).toEqual([`${entityId}:signer-b:1`, `${entityId}:signer-c:1`]);
    expect([...contexts.values()].map(context => context.proposerReplicaId)).toEqual([
      `${entityId}:signer-a`,
      `${entityId}:signer-a`,
    ]);
  });

  test('allows an exact duplicate and rejects a conflicting slice', () => {
    const contexts = new Map<string, EntityInfraContext>();
    const appliedReplicaId = `0x${'aa'.repeat(32)}:signer-b`;
    const shapes = new Map<string, string>();
    const first = describeEntityInputCommitShape({
      entityTxs: [{ type: 'setHubConfig' }],
    });
    const second = describeEntityInputCommitShape({
      entityTxs: [],
      jPrefixAttestations: new Map([['signer-a', { targetEntityHeight: 2 }]]),
    });
    collectRuntimeEntityContext(
      contexts,
      `0x${'aa'.repeat(32)}`,
      appliedReplicaId,
      makeContext(),
      first,
      shapes,
    );
    collectRuntimeEntityContext(
      contexts,
      `0x${'aa'.repeat(32)}`,
      appliedReplicaId,
      makeContext(),
      first,
      shapes,
    );
    expect(() => collectRuntimeEntityContext(
      contexts,
      `0x${'aa'.repeat(32)}`,
      appliedReplicaId,
      makeContext(false),
      second,
      shapes,
    )).toThrow(
      `RUNTIME_ENTITY_CONTEXT_COLLISION:${appliedReplicaId}:1:existing=1/genesis:incoming=1/genesis:` +
      `existingInput=${first}:incomingInput=${second}`,
    );
  });

  test('describes commit-capable input fields without hashes or signatures', () => {
    expect(describeEntityInputCommitShape({
      from: `0x${'cc'.repeat(20)}`,
      runtimeId: `0x${'dd'.repeat(20)}`,
      entityTxs: [{ type: 'setHubConfig' }, { type: 'initOrderbookExt' }],
      proposedFrame: { height: 3, hash: `0x${'ab'.repeat(32)}` },
      hashPrecommits: new Map([['a', 'b']]),
      hashPrecommitFrame: { height: 3 },
      jPrefixAttestations: new Map([['signer-a', { targetEntityHeight: 2 }]]),
      leaderTimeoutVote: { targetHeight: 4 },
    })).toBe(
      `from=0x${'cc'.repeat(20)};` +
      `runtimeId=0x${'dd'.repeat(20)};` +
      `txs=setHubConfig,initOrderbookExt*2;` +
      `proposed=3/0xababababab..;` +
      `precommit=3*1;` +
      `jPrefix=2*1;` +
      `leader=4`,
    );
  });

  test('rejects an input/context Entity binding mismatch', () => {
    expect(() => collectRuntimeEntityContext(new Map(), `0x${'bb'.repeat(32)}`, `0x${'bb'.repeat(32)}:signer-b`, makeContext()))
      .toThrow('RUNTIME_ENTITY_CONTEXT_REPLICA_BINDING_INVALID');
  });
});
