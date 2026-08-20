import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateEntityInfraContext } from '../../../entity/consensus/frame/infra-context-validation';
import { encodeCanonicalConsensusValue } from '../../../protocol/serialization/canonical-consensus-value';
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
  test('a decoded context has no symbol keys and hashes as Entity protocol bytes', () => {
    const decoded = validateEntityInfraContext(makeContext());
    expect(Object.getOwnPropertySymbols(decoded)).toEqual([]);
    expect(() => encodeCanonicalConsensusValue(decoded)).not.toThrow();
  });

  test('live proposal skips the second parse; WAL/network still call it', () => {
    const application = readFileSync(
      join(import.meta.dir, '../../../entity/consensus/frame/application.ts'),
      'utf8',
    );
    const start = readFileSync(
      join(import.meta.dir, '../../../entity/consensus/proposal/start.ts'),
      'utf8',
    );
    const validation = readFileSync(
      join(import.meta.dir, '../../../entity/consensus/frame/infra-context-validation.ts'),
      'utf8',
    );
    expect(application).toContain('if (!inProcessInfraValidated)');
    expect(application).toContain('entityContext = validateEntityInfraContext(entityContext)');
    expect(start).toContain('env.state.timestamp,\n    !fitted.replayed');
    expect(validation).not.toContain('VALIDATED_ENTITY_INFRA_CONTEXT');
    expect(validation).not.toContain('Symbol(');
  });
});
