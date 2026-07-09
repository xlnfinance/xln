import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resetMeshJurisdictionsCache,
  resolveMeshJurisdictionConfig,
} from '../orchestrator/mesh-jurisdictions';

const writeJurisdictions = (payload: Record<string, unknown>): string => {
  const root = mkdtempSync(join(tmpdir(), 'xln-mesh-jurisdictions-'));
  const path = join(root, 'jurisdictions.json');
  mkdirSync(root, { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return path;
};

const withJurisdictions = <T>(payload: Record<string, unknown>, fn: () => T): T => {
  const previousPath = process.env['XLN_JURISDICTIONS_PATH'];
  const path = writeJurisdictions(payload);
  process.env['XLN_JURISDICTIONS_PATH'] = path;
  resetMeshJurisdictionsCache();
  try {
    return fn();
  } finally {
    if (previousPath === undefined) delete process.env['XLN_JURISDICTIONS_PATH'];
    else process.env['XLN_JURISDICTIONS_PATH'] = previousPath;
    resetMeshJurisdictionsCache();
    rmSync(join(path, '..'), { recursive: true, force: true });
  }
};

const stack = (
  name: string,
  rpc: string,
  depository: string,
  entityProvider: string,
  extra: Record<string, unknown> = {},
) => ({
  name,
  chainId: Number.parseInt(depository.slice(2, 4), 16) || 1,
  rpc,
  contracts: {
    depository,
    entityProvider,
    account: `0x${depository.slice(2).padStart(40, '0')}`,
    deltaTransformer: `0x${entityProvider.slice(2).padStart(40, '0')}`,
  },
  ...extra,
});

describe('mesh jurisdiction config resolution', () => {
  test('matches public primary rpc without relying on arrakis key or label', () => {
    withJurisdictions({
      version: '1',
      jurisdictions: {
        tron: stack('Tron', '/rpc2', '0x2200000000000000000000000000000000000000', '0x2300000000000000000000000000000000000000'),
        renamedPrimary: stack('Whatever Label', '/rpc', '0x1100000000000000000000000000000000000000', '0x1200000000000000000000000000000000000000'),
      },
    }, () => {
      const resolved = resolveMeshJurisdictionConfig('http://127.0.0.1:8545');

      expect(resolved.name).toBe('Whatever Label');
      expect(resolved.rpc).toBe('http://127.0.0.1:8545');
      expect(resolved.contracts?.depository).toBe('0x1100000000000000000000000000000000000000');
    });
  });

  test('uses explicit primary marker when no rpc override is available', () => {
    withJurisdictions({
      version: '1',
      jurisdictions: {
        secondaryFirst: stack('Tron', '/rpc2', '0x2200000000000000000000000000000000000000', '0x2300000000000000000000000000000000000000'),
        base: stack('Base Mainnet', 'https://base.example.invalid', '0x3300000000000000000000000000000000000000', '0x3400000000000000000000000000000000000000', { primary: true }),
      },
    }, () => {
      const resolved = resolveMeshJurisdictionConfig('');

      expect(resolved.name).toBe('Base Mainnet');
      expect(resolved.rpc).toBe('https://base.example.invalid');
    });
  });

  test('fails closed when no configured jurisdiction has required contracts', () => {
    withJurisdictions({
      version: '1',
      jurisdictions: {
        incomplete: {
          name: 'Incomplete',
          chainId: 1,
          rpc: '/rpc',
          contracts: { depository: '0x1' },
        },
        legacyPartial: {
          name: 'Legacy Partial',
          chainId: 1,
          rpc: '/rpc',
          contracts: {
            depository: '0x0000000000000000000000000000000000000001',
            entityProvider: '0x0000000000000000000000000000000000000002',
          },
        },
      },
    }, () => {
      expect(() => resolveMeshJurisdictionConfig('/rpc')).toThrow('JURISDICTION_NOT_FOUND');
    });
  });
});
