import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  asValidatedEntityInfraContext,
  validateEntityInfraContext,
} from '../../../entity/consensus/frame/infra-context-validation';
import type { EntityInfraContext } from '../../../types/entity/infra-context';

const makeContext = (): EntityInfraContext => ({
  version: 1,
  proposerReplicaId: `0x${'aa'.repeat(32)}:signer-a`,
  entityId: `0x${'aa'.repeat(32)}`,
  proposerSignerId: 'signer-a',
  parentFrameHash: 'genesis',
  height: 1,
  gossipProfiles: [],
  peerAssertions: [{ entityId: `0x${'bb'.repeat(32)}`, online: true }],
  htlc: { version: 1, entries: [], originated: [] },
});

describe('Entity infra context in-process validate-once', () => {
  test('a stamped context is identity on the next parse; a clone is not', () => {
    const first = validateEntityInfraContext(makeContext());
    expect(asValidatedEntityInfraContext(first)).toBe(first);
    expect(validateEntityInfraContext(first)).toBe(first);
    const cloned = structuredClone(first);
    expect(asValidatedEntityInfraContext(cloned)).toBeUndefined();
    expect(validateEntityInfraContext(cloned)).not.toBe(cloned);
    expect(validateEntityInfraContext(cloned)).not.toBe(first);
  });

  test('apply and WAL still call the parser; stamp makes live Hub re-walks free', () => {
    const application = readFileSync(
      join(import.meta.dir, '../../../entity/consensus/frame/application.ts'),
      'utf8',
    );
    const validation = readFileSync(
      join(import.meta.dir, '../../../entity/consensus/frame/infra-context-validation.ts'),
      'utf8',
    );
    expect(application).toContain('entityContext = validateEntityInfraContext(entityContext)');
    expect(validation).toContain('VALIDATED_ENTITY_INFRA_CONTEXT');
    expect(validation).toContain('if (trusted) return trusted');
  });
});
