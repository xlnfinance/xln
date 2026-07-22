import { describe, expect, test } from 'bun:test';

import { buildLocalRuntimeOwner } from '../server/local-runtime-owner';

const SIGNER = `0x${'11'.repeat(20)}`;
const DEPOSITORY = `0x${'22'.repeat(20)}`;
const ENTITY_PROVIDER = `0x${'33'.repeat(20)}`;

describe('local runtime owner', () => {
  test('derives one deterministic local entity bound to the live jurisdiction', () => {
    const first = buildLocalRuntimeOwner({
      signerId: SIGNER,
      profileName: 'xln finance',
      jurisdictionName: 'local',
      jurisdiction: {
        name: 'local',
        blockNumber: 0n,
        stateRoot: new Uint8Array(32),
        mempool: [],
        blockDelayMs: 300,
        blockTimeMs: 300,
        lastBlockTimestamp: 0,
        position: { x: 0, y: 0, z: 0 },
        chainId: 31_337,
        depositoryAddress: DEPOSITORY,
        entityProviderAddress: ENTITY_PROVIDER,
      },
    });
    const second = buildLocalRuntimeOwner({
      signerId: SIGNER.toUpperCase().replace('0X', '0x'),
      profileName: 'xln finance',
      jurisdictionName: 'local',
      jurisdiction: {
        name: 'local',
        blockNumber: 0n,
        stateRoot: new Uint8Array(32),
        mempool: [],
        blockDelayMs: 300,
        lastBlockTimestamp: 0,
        position: { x: 0, y: 0, z: 0 },
        chainId: 31_337,
        depositoryAddress: DEPOSITORY,
        entityProviderAddress: ENTITY_PROVIDER,
      },
    });

    expect(second.entityId).toBe(first.entityId);
    expect(first.signerId).toBe(SIGNER);
    expect(first.config).toEqual({
      mode: 'proposer-based',
      threshold: 1n,
      validators: [SIGNER],
      shares: { [SIGNER]: 1n },
      jurisdiction: {
        address: 'jreplica://local',
        name: 'local',
        chainId: 31_337,
        blockTimeMs: 300,
        depositoryAddress: DEPOSITORY,
        entityProviderAddress: ENTITY_PROVIDER,
      },
    });
  });
});
