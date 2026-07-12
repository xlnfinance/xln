import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectCliJurisdiction } from '../jurisdiction/cli-jurisdiction';

const payload = {
  jurisdictions: {
    stale: {
      name: 'Stale',
      primary: true,
      status: 'pending',
      rpc: 'http://127.0.0.1:9999',
      chainId: 1,
      contracts: {
        depository: `0x${'11'.repeat(20)}`,
        entityProvider: `0x${'12'.repeat(20)}`,
      },
    },
    base: {
      name: 'Base',
      status: 'active',
      rpc: '/rpc',
      chainId: 8453,
      contracts: {
        account: `0x${'21'.repeat(20)}`,
        depository: `0x${'22'.repeat(20)}`,
        entityProvider: `0x${'23'.repeat(20)}`,
        deltaTransformer: `0x${'24'.repeat(20)}`,
      },
    },
  },
};

describe('CLI jurisdiction selection', () => {
  test('resolves current contracts from jurisdiction config instead of embedded constants', () => {
    const selected = selectCliJurisdiction(payload, { rpcUrl: 'https://xln.finance/rpc' });
    expect(selected.key).toBe('base');
    expect(selected.rpcUrl).toBe('https://xln.finance/rpc');
    expect(selected.chainId).toBe(8453);
    expect(selected.contracts.depository).toBe(`0x${'22'.repeat(20)}`);
    expect(selected.contracts.entityProvider).toBe(`0x${'23'.repeat(20)}`);
  });

  test('honors explicit jurisdiction key and rejects incomplete contract entries', () => {
    expect(() => selectCliJurisdiction({
      jurisdictions: {
        broken: {
          name: 'Broken',
          chainId: 31337,
          rpc: '/rpc',
          contracts: { depository: `0x${'33'.repeat(20)}` },
        },
      },
    }, { rpcUrl: 'https://xln.finance/rpc', jurisdictionKey: 'broken' })).toThrow('CLI_JURISDICTION_CONTRACTS_INCOMPLETE:broken');

    const selected = selectCliJurisdiction(payload, {
      rpcUrl: 'http://localhost:8545',
      jurisdictionKey: 'base',
    });
    expect(selected.key).toBe('base');
  });

  test('CLI source does not contain stale deployed contract constants', () => {
    const source = readFileSync(join(process.cwd(), 'runtime/server/cli.ts'), 'utf8');
    expect(source).not.toContain('0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9');
    expect(source).not.toContain('0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
    expect(source).not.toContain('0x0165878A594ca255338adfa4d48449f69242Eb8F');
    expect(source).not.toContain('deployed 2025-01-29');
  });
});
