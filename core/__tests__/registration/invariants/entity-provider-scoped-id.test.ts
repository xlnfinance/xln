import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { createProviderScopedEntityId } from '../../../entity/id';

describe('provider-scoped Entity id', () => {
  test('binds the provider into the Entity id', () => {
    const provider = '0x1111111111111111111111111111111111111111';
    const entityId = `0x${'22'.repeat(32)}`;
    expect(createProviderScopedEntityId(provider, entityId)).toBe(
      ethers.keccak256(ethers.solidityPacked(['address', 'bytes32'], [provider, entityId])),
    );
  });
});
