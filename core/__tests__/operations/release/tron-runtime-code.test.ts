import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { keccak256 } from 'ethers';
import fixture from '../../fixtures/jurisdiction/tron-runtime-bytecode.json';

const require = createRequire(import.meta.url);
const { tronRuntimeCodeHash } = require('../../../../jurisdictions/scripts/deploy-chain-matrix.cjs') as {
  tronRuntimeCodeHash(name: string, info: Record<string, unknown>): string;
};

describe('native TRON deployment runtime code evidence', () => {
  test('hashes the actual TVM runtime bytes independently of creation code', () => {
    const info = { ...fixture.contractInfo, bytecode: fixture.creationBytecode };
    expect(tronRuntimeCodeHash('ERC20Mock', info)).toBe(fixture.expectedRuntimeCodeHash);
    expect(tronRuntimeCodeHash('ERC20Mock', info)).not.toBe(keccak256(`0x${fixture.creationBytecode}`));
    expect(tronRuntimeCodeHash('ERC20Mock', { ...info, bytecode: '00' })).toBe(fixture.expectedRuntimeCodeHash);
  });

  test('rejects missing or malformed runtime bytes even when creation code is available', () => {
    for (const runtimecode of [undefined, null, '', '0x', '0x00', '0', 'zz', 123]) {
      expect(() => tronRuntimeCodeHash('ERC20Mock', { runtimecode, bytecode: fixture.creationBytecode })).toThrow(
        'TRON_DEPLOY_RUNTIME_CODE_INVALID:ERC20Mock',
      );
    }
  });
});
