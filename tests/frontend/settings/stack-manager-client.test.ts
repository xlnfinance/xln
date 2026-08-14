import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  decodeStackManagerDeployResponse,
  decodeStackManagerStatusResponse,
  deployStack,
  fetchStackManagerStatus,
} from '../../../frontend/src/lib/components/Settings/stack-manager-client';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const TX_HASH = `0x${'a'.repeat(64)}`;
const DEPLOYMENTS = [
  'account',
  'depositoryBounds',
  'hashLadderRegistry',
  'nftCustody',
  'hankoVerifier',
  'entityProvider',
  'depository',
  'deltaTransformer',
] as const;

const deploymentResponse = () => ({
  ok: true,
  result: {
    manifest: {
      stackVersion: 'V1',
      network: 'Arbitrum One',
      chainId: 42161,
      deployer: ADDRESS,
      foundationRecipient: ADDRESS,
      entityProviderDeploymentBlock: 12,
      contracts: Object.fromEntries(DEPLOYMENTS.map((name) => [name, ADDRESS])),
      evmContracts: {
        ...Object.fromEntries(DEPLOYMENTS.map((name) => [name, {
          address: ADDRESS,
          deploymentBlock: 12,
          transactionHash: TX_HASH,
        }])),
        stablecoinRegistration: { transactionHash: TX_HASH, blockNumber: 13 },
      },
      registeredTokens: { USDT: { address: ADDRESS, tokenId: 1, decimals: 6 } },
    },
    localJurisdiction: { key: 'arbitrum-one', name: 'Arbitrum One' },
    publication: { status: 'not_requested', scope: 'local' },
  },
});

describe('Stack Manager browser boundary', () => {
  test('decodes an exact status and rejects response drift', () => {
    const valid = {
      ok: true,
      status: { phase: 'idle', active: false, updatedAt: '2026-08-14T08:00:00.000Z' },
      probe: { rpcUrl: 'https://arb.example/rpc', chainId: 42161, signerId: ADDRESS, nativeBalanceWei: '1000000000000000000' },
    };
    expect(decodeStackManagerStatusResponse(valid).probe?.chainId).toBe(42161);
    expect(() => decodeStackManagerStatusResponse({ ...valid, ignored: true })).toThrow('STACK_MANAGER_STATUS_RESPONSE_KEYS_INVALID');
    expect(() => decodeStackManagerStatusResponse({
      ...valid,
      status: { ...valid.status, updatedAt: 'yesterday' },
    })).toThrow('STACK_MANAGER_UPDATED_AT_INVALID');
  });

  test('decodes canonical V1 deployment evidence and publication state', () => {
    const decoded = decodeStackManagerDeployResponse(deploymentResponse());
    expect(decoded.result.manifest.stackVersion).toBe('V1');
    expect(decoded.result.manifest.contracts.entityProvider).toBe(ADDRESS);
    expect(decoded.result.publication).toEqual({ status: 'not_requested', scope: 'local' });

    const invalid = deploymentResponse();
    expect(() => decodeStackManagerDeployResponse({
      ...invalid,
      result: { ...invalid.result, publication: { status: 'pending', scope: 'local' } },
    })).toThrow('STACK_MANAGER_PENDING_PUBLICATION_INVALID');

    const official = deploymentResponse();
    const decodedOfficial = decodeStackManagerDeployResponse({
      ...official,
      result: {
        ...official.result,
        publication: {
          status: 'pending',
          scope: 'official',
          reason: 'FOUNDATION_PUBLICATION_AUTHORITY_UNAVAILABLE',
        },
      },
    });
    expect(decodedOfficial.result.publication.scope).toBe('official');
  });

  test('uses encoded probe query and keeps admin capability out of deployment JSON', async () => {
    let statusUrl = '';
    let statusInit: RequestInit | undefined;
    await fetchStackManagerStatus('https://arb.example/rpc?a=1', ADDRESS, 'admin-secret', async (input, init) => {
      statusUrl = String(input);
      statusInit = init;
      return Response.json({
        ok: true,
        status: { phase: 'idle', active: false, updatedAt: '2026-08-14T08:00:00.000Z' },
        probe: { rpcUrl: 'https://arb.example/rpc?a=1', chainId: 42161, signerId: ADDRESS, nativeBalanceWei: '1' },
      });
    });
    expect(statusUrl).toContain('rpcUrl=https%3A%2F%2Farb.example%2Frpc%3Fa%3D1');
    expect(statusUrl).toContain(`signerId=${ADDRESS}`);
    expect(new Headers(statusInit?.headers).get('authorization')).toBe('Bearer admin-secret');

    let captured: RequestInit | undefined;
    await deployStack({
      name: 'Arbitrum One',
      key: 'arbitrum-one',
      rpcUrl: 'https://arb.example/rpc',
      expectedChainId: 42161,
      blockTimeMs: 250,
      currency: 'ETH',
      explorer: 'https://arbiscan.io',
      description: 'Arbitrum jurisdiction',
      signerId: ADDRESS,
      foundationRecipient: ADDRESS,
      stablecoin: { kind: 'existing', address: ADDRESS },
      publication: 'local',
      confirmations: 2,
    }, 'admin-secret', async (_input, init) => {
      captured = init;
      return Response.json(deploymentResponse());
    });
    expect(new Headers(captured?.headers).get('authorization')).toBe('Bearer admin-secret');
    expect(String(captured?.body)).toContain('"stackVersion":"V1"');
    expect(String(captured?.body)).not.toContain('admin-secret');
  });

  test('wires a dedicated tab and never persists the admin capability', () => {
    const panel = readFileSync('frontend/src/lib/view/panels/SettingsPanel.svelte', 'utf8');
    const component = readFileSync('frontend/src/lib/components/Settings/StackManager.svelte', 'utf8');
    expect(panel).toContain('data-testid="settings-stack-manager-tab"');
    expect(panel).toContain('<StackManager />');
    expect(component).toContain('type="password"');
    expect(component).not.toContain('localStorage');
    expect(component).not.toContain('sessionStorage');
  });
});
