import { describe, expect, test } from 'bun:test';
import { resolveActiveLocalReplica } from '../../frontend/src/lib/view/local-runtime-selection';

type Replica = { entityId: string; signerId: string };

describe('local runtime Entity selection', () => {
  test('waits for exact vault Entity + signer metadata instead of using Map order', () => {
    const wrong = { entityId: '0xentity-b', signerId: '0xsigner-b' };
    const expected = { entityId: '0xentity-a', signerId: '0xsigner-a' };
    const replicas = new Map<string, Replica>([
      [`${wrong.entityId}:${wrong.signerId}`, wrong],
      [`${expected.entityId}:${expected.signerId}`, expected],
    ]);

    expect(resolveActiveLocalReplica(replicas, null)).toBeNull();
    expect(resolveActiveLocalReplica(replicas, { address: expected.signerId })).toBeNull();
    expect(resolveActiveLocalReplica(replicas, {
      entityId: expected.entityId.toUpperCase(),
      address: expected.signerId.toUpperCase(),
    })).toBe(expected);
  });

});
