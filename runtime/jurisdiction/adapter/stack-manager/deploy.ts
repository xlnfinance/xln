/**
 * Canonical V1 stack deployment orchestration shared by Bun CLI and server API.
 * It performs preflight, invokes the sole Hardhat deploy implementation, proves
 * receipts/linked bytecode, then and only then persists discovery metadata. [99/100]
 */

import { JsonRpcProvider, Wallet, hexlify } from 'ethers';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJurisdictionStackManifest } from './validation';
import {
  acquireStackManagerDeploymentLock,
  assertJurisdictionStackKeyAvailable,
  persistVerifiedJurisdictionStack,
} from './persistence';
import { verifyJurisdictionStack } from './verification';
import type {
  DeployJurisdictionStackRequest,
  DeployJurisdictionStackResult,
  StackManagerPhase,
  StackManagerProbe,
} from './types';

export type StackDeploymentOptions = Readonly<{
  signerPrivateKey: Uint8Array;
  officialAuthorityVerified?: boolean;
  onPhase?: (phase: StackManagerPhase) => void;
}>;

const DEPLOY_TAIL_MAX_BYTES = 64 * 1024;

const readBoundedTail = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  let tail = new Uint8Array();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const combined = new Uint8Array(Math.min(DEPLOY_TAIL_MAX_BYTES, tail.length + value.length));
    const sourceOffset = Math.max(0, tail.length + value.length - DEPLOY_TAIL_MAX_BYTES);
    const source = new Uint8Array(tail.length + value.length);
    source.set(tail);
    source.set(value, tail.length);
    combined.set(source.subarray(sourceOffset));
    tail = combined;
  }
  return new TextDecoder('utf8', { fatal: false }).decode(tail);
};

const sanitizeDeployTail = (tail: string, secretHex: string, rpcUrl: string): string =>
  tail
    .replaceAll(secretHex, '[REDACTED_PRIVATE_KEY]')
    .replaceAll(secretHex.slice(2), '[REDACTED_PRIVATE_KEY]')
    .replaceAll(rpcUrl, '[REDACTED_RPC_URL]')
    .replaceAll('\n', ' ')
    .slice(-4_096)
    .trim();

const CHILD_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'BUN_INSTALL', 'CI', 'NO_COLOR',
] as const;

export const buildStackManagerChildEnv = (deployment: Readonly<{
  rpcUrl: string;
  chainId: number;
  signerPrivateKeyHex: string;
  foundationRecipient: string;
  stablecoinAddress: string;
  deployTestStablecoin: boolean;
  outputPath: string;
}>): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    HARDHAT_DISABLE_TELEMETRY_PROMPT: '1',
    XLN_STACK_MANAGER_RPC_URL: deployment.rpcUrl,
    XLN_STACK_MANAGER_CHAIN_ID: String(deployment.chainId),
    DEPLOYER_PRIVATE_KEY: deployment.signerPrivateKeyHex,
    XLN_FOUNDATION_ADDRESS: deployment.foundationRecipient,
    XLN_STABLECOIN_ADDRESS: deployment.stablecoinAddress,
    XLN_DEPLOY_TEST_STABLECOIN: deployment.deployTestStablecoin ? '1' : '0',
    XLN_DEPLOY_OUTPUT: deployment.outputPath,
  };
};

export const probeJurisdictionStackTarget = async (
  request: Pick<DeployJurisdictionStackRequest, 'rpcUrl' | 'signerId'> &
    Readonly<{ expectedChainId?: number }>,
): Promise<StackManagerProbe> => {
  const provider = new JsonRpcProvider(request.rpcUrl);
  try {
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);
    if (request.expectedChainId !== undefined && chainId !== request.expectedChainId) {
      throw new Error(`STACK_MANAGER_CHAIN_ID_MISMATCH:expected=${request.expectedChainId}:actual=${chainId}`);
    }
    const nativeBalanceWei = (await provider.getBalance(request.signerId)).toString();
    return { rpcUrl: request.rpcUrl, chainId, signerId: request.signerId, nativeBalanceWei };
  } finally {
    provider.destroy();
  }
};

export const deployJurisdictionStack = async (
  request: DeployJurisdictionStackRequest,
  options: StackDeploymentOptions,
): Promise<DeployJurisdictionStackResult> => {
  options.onPhase?.('preflight');
  const signerPrivateKeyHex = hexlify(options.signerPrivateKey);
  const wallet = new Wallet(signerPrivateKeyHex);
  if (wallet.address.toLowerCase() !== request.signerId.toLowerCase()) {
    throw new Error('STACK_MANAGER_SIGNER_KEY_MISMATCH');
  }
  const probe = await probeJurisdictionStackTarget(request);
  if (BigInt(probe.nativeBalanceWei) === 0n) throw new Error('STACK_MANAGER_SIGNER_GAS_BALANCE_EMPTY');
  const releaseDeploymentLock = await acquireStackManagerDeploymentLock();
  let temporaryDirectory = '';
  let provider: JsonRpcProvider | null = null;
  try {
    await assertJurisdictionStackKeyAvailable(request.key);
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'xln-stack-manager-'));
    const outputPath = join(temporaryDirectory, 'manifest.json');
    provider = new JsonRpcProvider(request.rpcUrl);
    options.onPhase?.('deploying');
    const child = Bun.spawn([
      'bunx', 'hardhat', 'run', 'scripts/deploy-stack.cjs', '--network', 'stack-manager',
    ], {
      cwd: new URL('../../../../jurisdictions', import.meta.url).pathname,
      env: buildStackManagerChildEnv({
        rpcUrl: request.rpcUrl,
        chainId: request.expectedChainId,
        signerPrivateKeyHex,
        foundationRecipient: request.foundationRecipient,
        stablecoinAddress: request.stablecoin.kind === 'existing' ? request.stablecoin.address : '',
        deployTestStablecoin: request.stablecoin.kind === 'test',
        outputPath,
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdoutTail, stderrTail] = await Promise.all([
      child.exited,
      readBoundedTail(child.stdout),
      readBoundedTail(child.stderr),
    ]);
    if (exitCode !== 0) {
      const tail = sanitizeDeployTail(stderrTail || stdoutTail, signerPrivateKeyHex, request.rpcUrl);
      throw new Error(`STACK_MANAGER_HARDHAT_DEPLOY_FAILED:exit=${exitCode}${tail ? `:tail=${tail}` : ''}`);
    }
    const manifest = decodeJurisdictionStackManifest(JSON.parse(await readFile(outputPath, 'utf8')));
    if (manifest.chainId !== request.expectedChainId) throw new Error('STACK_MANAGER_DEPLOY_CHAIN_ID_MISMATCH');
    if (manifest.deployer.toLowerCase() !== request.signerId.toLowerCase()) throw new Error('STACK_MANAGER_DEPLOYER_MISMATCH');
    if (manifest.foundationRecipient.toLowerCase() !== request.foundationRecipient.toLowerCase()) {
      throw new Error('STACK_MANAGER_FOUNDATION_RECIPIENT_MISMATCH');
    }
    options.onPhase?.('verifying');
    await verifyJurisdictionStack(provider, manifest, request.confirmations);
    options.onPhase?.('persisting');
    const localJurisdiction = await persistVerifiedJurisdictionStack(request, manifest);
    const publication = request.publication === 'local'
      ? { status: 'not_requested' as const, scope: 'local' as const }
      : request.publication === 'official' && !options.officialAuthorityVerified
        ? {
            status: 'pending' as const,
            scope: 'official' as const,
            reason: 'FOUNDATION_PUBLICATION_AUTHORITY_UNAVAILABLE' as const,
          }
        : {
            status: 'pending' as const,
            scope: request.publication,
            reason: 'JURISDICTION_GOSSIP_PUBLICATION_PROTOCOL_UNAVAILABLE' as const,
          };
    options.onPhase?.('complete');
    return { manifest, localJurisdiction, publication };
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    provider?.destroy();
    await releaseDeploymentLock();
  }
};
