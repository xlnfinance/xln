import { describe, expect, test } from 'bun:test';
import { collectRuntimeEntityContext } from '../../../runtime/entity-input/entity-context-collection';
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
    expect([...contexts.keys()]).toEqual([`0x${'aa'.repeat(32)}:signer-b`]);
  });

  test('records the same proposer context independently for two local sibling replicas', () => {
    const contexts = new Map<string, EntityInfraContext>();
    const entityId = `0x${'aa'.repeat(32)}`;
    collectRuntimeEntityContext(contexts, entityId, `${entityId}:signer-b`, makeContext());
    collectRuntimeEntityContext(contexts, entityId, `${entityId}:signer-c`, makeContext());
    expect([...contexts.keys()]).toEqual([`${entityId}:signer-b`, `${entityId}:signer-c`]);
    expect([...contexts.values()].map(context => context.proposerReplicaId)).toEqual([
      `${entityId}:signer-a`,
      `${entityId}:signer-a`,
    ]);
  });

  test('allows an exact duplicate and rejects a conflicting slice', () => {
    const contexts = new Map<string, EntityInfraContext>();
    const appliedReplicaId = `0x${'aa'.repeat(32)}:signer-b`;
    collectRuntimeEntityContext(contexts, `0x${'aa'.repeat(32)}`, appliedReplicaId, makeContext());
    collectRuntimeEntityContext(contexts, `0x${'aa'.repeat(32)}`, appliedReplicaId, makeContext());
    expect(() => collectRuntimeEntityContext(contexts, `0x${'aa'.repeat(32)}`, appliedReplicaId, makeContext(false)))
      .toThrow(`RUNTIME_ENTITY_CONTEXT_COLLISION:${appliedReplicaId}`);
  });

  test('rejects an input/context Entity binding mismatch', () => {
    expect(() => collectRuntimeEntityContext(new Map(), `0x${'bb'.repeat(32)}`, `0x${'bb'.repeat(32)}:signer-b`, makeContext()))
      .toThrow('RUNTIME_ENTITY_CONTEXT_REPLICA_BINDING_INVALID');
  });
});
