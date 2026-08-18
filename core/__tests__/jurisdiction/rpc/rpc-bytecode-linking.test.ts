import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { linkArtifactBytecode } from '../../../jurisdiction/adapter/rpc-utils';

const placeholderFor = (name: string): string => `__$${ethers.id(name).slice(2, 36)}$__`;

describe('RPC artifact bytecode linking', () => {
  test('links each solc placeholder to its own library address', () => {
    const accountName = 'contracts/Account.sol:Account';
    const boundsName = 'contracts/DepositoryBounds.sol:DepositoryBounds';
    const accountAddress = `0x${'11'.repeat(20)}`;
    const boundsAddress = `0x${'22'.repeat(20)}`;
    const bytecode = `0x60${placeholderFor(accountName)}61${placeholderFor(boundsName)}62${placeholderFor(accountName)}`;

    expect(linkArtifactBytecode(bytecode, {
      [accountName]: accountAddress,
      [boundsName]: boundsAddress,
    })).toBe(`0x60${'11'.repeat(20)}61${'22'.repeat(20)}62${'11'.repeat(20)}`);
  });

  test('fails loudly when a supplied library does not match the artifact', () => {
    expect(() => linkArtifactBytecode(`0x${placeholderFor('contracts/A.sol:A')}`, {
      'contracts/B.sol:B': `0x${'33'.repeat(20)}`,
    })).toThrow('Linked library placeholder not found');
  });
});
