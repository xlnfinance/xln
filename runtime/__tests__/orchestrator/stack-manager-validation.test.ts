import { describe, expect, test } from 'bun:test';
import { Wallet, getBytes } from 'ethers';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  decodeDeployJurisdictionStackRequest,
  decodeJurisdictionStackManifest,
} from '../../jurisdiction/adapter/stack-manager/validation';
import { requiresLocalNodeOperator } from '../../api/server/control/node-http-access';
import {
  acquireStackManagerDeploymentLock,
  persistVerifiedJurisdictionStack,
} from '../../jurisdiction/adapter/stack-manager/persistence';
import {
  buildStackManagerChildEnv,
  deployJurisdictionStack,
} from '../../jurisdiction/adapter/stack-manager/deploy';
import { validateJurisdictionsDataValue } from '../../jurisdiction/adapter/core/jurisdiction-loader';
import {
  computeJurisdictionGossipHash,
  createJurisdictionGossipAnnouncement,
  decodeJurisdictionGossipAnnouncement,
} from '../../jurisdiction/gossip/announcement';

const signer = new Wallet(`0x${'11'.repeat(32)}`).address;
const foundation = new Wallet(`0x${'22'.repeat(32)}`).address;
const address = (byte: string): string => `0x${byte.repeat(40)}`;
const transactionHash = (byte: string): string => `0x${byte.repeat(64)}`;
const names = [
  'account', 'depositoryBounds', 'hashLadderRegistry', 'nftCustody',
  'hankoVerifier', 'entityProvider', 'depository', 'deltaTransformer',
] as const;
const signerPrivateKey = `0x${'11'.repeat(32)}`;

const request = () => ({
  stackVersion: 'V1',
  name: 'Arbitrum One',
  key: 'arbitrum-one',
  rpcUrl: 'https://arb.example/rpc',
  expectedChainId: 42161,
  blockTimeMs: 250,
  currency: 'ETH',
  explorer: 'https://arbiscan.io',
  description: 'Arbitrum jurisdiction',
  signerId: signer,
  foundationRecipient: foundation,
  stablecoin: { kind: 'existing', address: address('a') },
  publication: 'community',
});

const manifest = () => ({
  stackVersion: 'V1',
  network: 'stack-manager',
  chainId: 42161,
  deployer: signer,
  foundationRecipient: foundation,
  entityProviderDeploymentBlock: 7,
  contracts: Object.fromEntries(names.map((name, index) => [name, address((index + 1).toString(16))])),
  evmContracts: {
    ...Object.fromEntries(names.map((name, index) => [name, {
      address: address((index + 1).toString(16)),
      deploymentBlock: index + 1,
      transactionHash: transactionHash((index + 1).toString(16)),
    }])),
    stablecoinRegistration: { transactionHash: transactionHash('a'), blockNumber: 9 },
  },
  registeredTokens: { USDT: { address: address('a'), tokenId: 1, decimals: 6 } },
});

const announcement = () => {
  const decodedRequest = decodeDeployJurisdictionStackRequest(request());
  const decodedManifest = decodeJurisdictionStackManifest(manifest());
  return createJurisdictionGossipAnnouncement({
    scope: 'community',
    key: decodedRequest.key,
    name: decodedRequest.name,
    rpcUrl: decodedRequest.rpcUrl,
    blockTimeMs: decodedRequest.blockTimeMs,
    currency: decodedRequest.currency,
    explorer: decodedRequest.explorer,
    ...(decodedRequest.description ? { description: decodedRequest.description } : {}),
    chainId: decodedManifest.chainId,
    deployer: decodedManifest.deployer,
    foundationRecipient: decodedManifest.foundationRecipient,
    entityProviderDeploymentBlock: decodedManifest.entityProviderDeploymentBlock,
    contracts: decodedManifest.contracts,
    stablecoin: { symbol: 'USDT', ...decodedManifest.registeredTokens.USDT },
  }, getBytes(signerPrivateKey));
};

describe('Stack Manager exact boundaries', () => {
  test('accepts canonical V1 operator input and normalizes EOAs', () => {
    const decoded = decodeDeployJurisdictionStackRequest(request());
    expect(decoded.expectedChainId).toBe(42161);
    expect(decoded.signerId).toBe(signer.toLowerCase());
    expect(decoded.confirmations).toBe(12);
    expect(decodeDeployJurisdictionStackRequest({
      ...request(),
      expectedChainId: 31_337,
    }).confirmations).toBe(1);
  });

  test('rejects private-key laundering and unknown compatibility fields', () => {
    expect(() => decodeDeployJurisdictionStackRequest({
      ...request(),
      privateKey: `0x${'33'.repeat(32)}`,
    })).toThrow('STACK_MANAGER_REQUEST_KEYS_INVALID');
    expect(() => decodeDeployJurisdictionStackRequest({ ...request(), stackVersion: 'V2' }))
      .toThrow('STACK_MANAGER_VERSION_INVALID');
  });

  test('rejects credential-bearing and non-http RPC URLs', () => {
    expect(() => decodeDeployJurisdictionStackRequest({
      ...request(), rpcUrl: 'https://alice:secret@arb.example/rpc',
    })).toThrow('STACK_MANAGER_RPC_URL_CREDENTIALS_FORBIDDEN');
    expect(() => decodeDeployJurisdictionStackRequest({ ...request(), rpcUrl: 'file:///etc/passwd' }))
      .toThrow('STACK_MANAGER_RPC_URL_PROTOCOL_INVALID');
  });

  test('decodes exact manifest evidence without trusting generic JSON', () => {
    const decoded = decodeJurisdictionStackManifest(manifest());
    expect(decoded.stackVersion).toBe('V1');
    expect(decoded.evmContracts.entityProvider.deploymentBlock).toBe(6);
    expect(decoded.registeredTokens.USDT.tokenId).toBe(1);
  });

  test('rejects incomplete or extended deployment evidence', () => {
    const extra = manifest();
    extra.evmContracts = { ...extra.evmContracts, unexpectedDepository: {} };
    expect(() => decodeJurisdictionStackManifest(extra)).toThrow('STACK_MANAGER_DEPLOYMENT_KEYS_INVALID');
    const missing = manifest();
    delete (missing.contracts as Record<string, unknown>)['account'];
    expect(() => decodeJurisdictionStackManifest(missing)).toThrow('STACK_MANAGER_CONTRACT_KEYS_INVALID');
  });

  test('keeps arbitrary-RPC status behind operator authority', () => {
    expect(requiresLocalNodeOperator(new URL('http://localhost/api/stack-manager/status'))).toBeTrue();
  });

  test('persists the complete verified manifest atomically and refuses replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xln-stack-manager-test-'));
    const path = join(directory, 'jurisdictions.json');
    const previous = process.env['XLN_JURISDICTIONS_PATH'];
    process.env['XLN_JURISDICTIONS_PATH'] = path;
    try {
      const decodedRequest = decodeDeployJurisdictionStackRequest(request());
      const decodedManifest = decodeJurisdictionStackManifest(manifest());
      const signedAnnouncement = announcement();
      await persistVerifiedJurisdictionStack(decodedRequest, decodedManifest, signedAnnouncement);
      const persisted = validateJurisdictionsDataValue(JSON.parse(await readFile(path, 'utf8')));
      const jurisdictions = persisted['jurisdictions'] as Record<string, Record<string, unknown>>;
      expect(jurisdictions['arbitrum-one']?.['stackVersion']).toBe('V1');
      expect(jurisdictions['arbitrum-one']?.['evmContracts']).toBeDefined();
      expect(jurisdictions['arbitrum-one']?.['blockTimeMs']).toBe(250);
      const announcements = persisted['jurisdictionAnnouncements'] as unknown[];
      expect(announcements).toHaveLength(1);
      expect(computeJurisdictionGossipHash(decodeJurisdictionGossipAnnouncement(announcements[0])))
        .toBe(computeJurisdictionGossipHash(signedAnnouncement));
      await expect(persistVerifiedJurisdictionStack(decodedRequest, decodedManifest))
        .rejects.toThrow('STACK_MANAGER_JURISDICTION_KEY_EXISTS');
    } finally {
      if (previous === undefined) delete process.env['XLN_JURISDICTIONS_PATH'];
      else process.env['XLN_JURISDICTIONS_PATH'] = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('signs exact community discovery and rejects payload or signature mutation', () => {
    const signed = announcement();
    expect(decodeJurisdictionGossipAnnouncement(signed)).toEqual(signed);
    expect(() => decodeJurisdictionGossipAnnouncement({ ...signed, rpcUrl: 'https://evil.example/rpc' }))
      .toThrow('JURISDICTION_GOSSIP_SIGNATURE_INVALID');
    expect(() => decodeJurisdictionGossipAnnouncement({ ...signed, signature: `0x${'00'.repeat(65)}` }))
      .toThrow('JURISDICTION_GOSSIP_SIGNATURE_INVALID');
  });

  test('rejects official publication before RPC or gas unless the configured root signer owns the stack', async () => {
    const officialRequest = decodeDeployJurisdictionStackRequest({
      ...request(),
      foundationRecipient: signer,
      publication: 'official',
    });
    await expect(deployJurisdictionStack(officialRequest, {
      signerPrivateKey: getBytes(signerPrivateKey),
    })).rejects.toThrow('FOUNDATION_PUBLICATION_AUTHORITY_UNAVAILABLE');
  });

  test('serializes CLI and server deployment with one cross-process lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xln-stack-manager-lock-test-'));
    const previous = process.env['XLN_JURISDICTIONS_PATH'];
    process.env['XLN_JURISDICTIONS_PATH'] = join(directory, 'jurisdictions.json');
    try {
      const release = await acquireStackManagerDeploymentLock();
      await expect(acquireStackManagerDeploymentLock()).rejects.toThrow('STACK_MANAGER_DEPLOYMENT_ACTIVE');
      await release();
      const releaseAgain = await acquireStackManagerDeploymentLock();
      await releaseAgain();
    } finally {
      if (previous === undefined) delete process.env['XLN_JURISDICTIONS_PATH'];
      else process.env['XLN_JURISDICTIONS_PATH'] = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('passes only the explicit deployment environment to Hardhat', () => {
    process.env['XLN_STACK_MANAGER_CANARY_SECRET'] = 'must-not-cross';
    try {
      const env = buildStackManagerChildEnv({
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 31337,
        signerPrivateKeyHex: `0x${'11'.repeat(32)}`,
        foundationRecipient: foundation,
        stablecoinAddress: '',
        deployTestStablecoin: true,
        outputPath: '/tmp/manifest.json',
      });
      expect(env['XLN_STACK_MANAGER_CANARY_SECRET']).toBeUndefined();
      expect(env['DEPLOYER_PRIVATE_KEY']).toBe(`0x${'11'.repeat(32)}`);
      expect(env['XLN_STACK_MANAGER_RPC_URL']).toBe('http://127.0.0.1:8545');
    } finally {
      delete process.env['XLN_STACK_MANAGER_CANARY_SECRET'];
    }
  });
});
