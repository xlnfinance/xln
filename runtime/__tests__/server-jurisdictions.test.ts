import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRuntimeJurisdictionsJson, updateJurisdictionsJson } from '../server/jurisdictions';

const tempRoots: string[] = [];

const withJurisdictionsPath = (payload: unknown): string => {
  const root = mkdtempSync(join(tmpdir(), 'xln-server-jurisdictions-'));
  tempRoots.push(root);
  const path = join(root, 'jurisdictions.json');
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.env['XLN_JURISDICTIONS_PATH'] = path;
  return path;
};

afterEach(() => {
  delete process.env['XLN_JURISDICTIONS_PATH'];
  delete process.env['PUBLIC_RPC'];
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('server jurisdiction writer', () => {
  test('rejects malformed canonical JSON instead of replacing it', async () => {
    const path = withJurisdictionsPath({ version: '1', jurisdictions: {} });
    writeFileSync(path, '{not-json', 'utf8');

    await expect(updateJurisdictionsJson({
      account: '0x0000000000000000000000000000000000000003',
      depository: '0x0000000000000000000000000000000000000004',
      entityProvider: '0x0000000000000000000000000000000000000005',
      deltaTransformer: '0x0000000000000000000000000000000000000006',
    }, 'http://127.0.0.1:8545', 31337, undefined, 2)).rejects.toThrow();

    expect(readFileSync(path, 'utf8')).toBe('{not-json');
  });

  test('rejects non-object jurisdiction shapes without rewriting them', async () => {
    const path = withJurisdictionsPath({ version: '1', jurisdictions: {} });
    for (const payload of ['[]', '{"version":"1","jurisdictions":[]}']) {
      writeFileSync(path, payload, 'utf8');
      await expect(updateJurisdictionsJson({
        account: '0x0000000000000000000000000000000000000003',
        depository: '0x0000000000000000000000000000000000000004',
        entityProvider: '0x0000000000000000000000000000000000000005',
        deltaTransformer: '0x0000000000000000000000000000000000000006',
      }, 'http://127.0.0.1:8545', 31337, undefined, 2)).rejects.toThrow('JURISDICTIONS_');
      expect(readFileSync(path, 'utf8')).toBe(payload);
    }
  });

  test('returns the selected jurisdiction key and preserves its configured display name', async () => {
    const path = withJurisdictionsPath({
      version: '1',
      jurisdictions: {
        renamedPrimary: {
          name: 'Base Local',
          primary: true,
          status: 'active',
          chainId: 31337,
          rpc: 'http://127.0.0.1:8545',
          contracts: {
            depository: '0x0000000000000000000000000000000000000001',
            entityProvider: '0x0000000000000000000000000000000000000002',
          },
        },
      },
    });

    const selected = await updateJurisdictionsJson({
      account: '0x0000000000000000000000000000000000000003',
      depository: '0x0000000000000000000000000000000000000004',
      entityProvider: '0x0000000000000000000000000000000000000005',
      deltaTransformer: '0x0000000000000000000000000000000000000006',
    }, 'http://127.0.0.1:8545', 31337, undefined, 2);

    expect(selected).toEqual({ key: 'renamedPrimary', name: 'Base Local' });
    const written = JSON.parse(readFileSync(path, 'utf8')) as {
      jurisdictions: Record<string, {
        name?: string;
        entityProviderDeploymentBlock?: number;
        contracts?: Record<string, string>;
      }>;
    };
    expect(written.jurisdictions['renamedPrimary']?.name).toBe('Base Local');
    expect(written.jurisdictions['renamedPrimary']?.contracts?.['depository'])
      .toBe('0x0000000000000000000000000000000000000004');
    expect(written.jurisdictions['renamedPrimary']?.entityProviderDeploymentBlock).toBe(2);
    expect(written.jurisdictions['arrakis']).toBeUndefined();
  });

  test('runtime jurisdiction export waits for the full contract set', async () => {
    const partialEnv = {
      activeJurisdiction: 'Testnet',
      jReplicas: new Map([
        ['Testnet', {
          name: 'Testnet',
          chainId: 31337,
          entityProviderDeploymentBlock: 2,
          rpcs: ['http://127.0.0.1:8545'],
          contracts: {
            depository: '0x0000000000000000000000000000000000000001',
            entityProvider: '0x0000000000000000000000000000000000000002',
          },
        }],
      ]),
    };

    await expect(buildRuntimeJurisdictionsJson(partialEnv as never)).resolves.toBeNull();

    const completeEnv = {
      activeJurisdiction: 'Testnet',
      jReplicas: new Map([
        ['Testnet', {
          name: 'Testnet',
          chainId: 31337,
          entityProviderDeploymentBlock: 2,
          rpcs: ['http://127.0.0.1:8545'],
          contracts: {
            account: '0x0000000000000000000000000000000000000003',
            depository: '0x0000000000000000000000000000000000000004',
            entityProvider: '0x0000000000000000000000000000000000000005',
            deltaTransformer: '0x0000000000000000000000000000000000000006',
          },
        }],
      ]),
    };

    const json = await buildRuntimeJurisdictionsJson(completeEnv as never);
    expect(json).toBeTruthy();
    const parsed = JSON.parse(String(json));
    expect(parsed.jurisdictions.testnet.contracts).toEqual({
      account: '0x0000000000000000000000000000000000000003',
      depository: '0x0000000000000000000000000000000000000004',
      entityProvider: '0x0000000000000000000000000000000000000005',
      deltaTransformer: '0x0000000000000000000000000000000000000006',
    });
    expect(parsed.jurisdictions.testnet.entityProviderDeploymentBlock).toBe(2);
  });
});
