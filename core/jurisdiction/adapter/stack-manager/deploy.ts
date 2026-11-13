import { safeStringify } from '../../../protocol/serialization';
/** Application adapter: dispatch the canonical Hardhat task, then separately admit discovery. */
import { JsonRpcProvider, Wallet, hexlify } from 'ethers';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assertStackDeploymentResumeExists, sanitizeDeploymentMessage } from './evidence';
import { decodeJurisdictionStackManifest, decodeRegisteredStackStablecoin, decodeStackDeploymentExecution, decodeStackManagerRpcUrl } from './validation';
import { acquireStackManagerDeploymentLock, assertJurisdictionStackKeyAvailable, assertStackResumeCatalogBinding, persistVerifiedJurisdictionStack } from './persistence';
import { createJurisdictionGossipAnnouncement, type JurisdictionGossipAnnouncement } from '../../gossip/announcement';
import { readStackPublicationRpc, sealStackPublicationRpc } from './evidence/publication';
import type { DeployJurisdictionStackRequest, DeployJurisdictionStackResult, StackManagerPhase, StackManagerProbe, StackDeploymentExecution } from './types';

export type StackDeploymentOptions = StackDeploymentExecution & Readonly<{
  signerPrivateKey: Uint8Array;
  officialFoundationSignerId?: string;
  publishJurisdiction?: (announcement: JurisdictionGossipAnnouncement) => boolean;
  onPhase?: (phase: StackManagerPhase) => void;
  evidenceDirectory?: string;
}>;

const CHILD_ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'BUN_INSTALL', 'CI', 'NO_COLOR'] as const;

export const buildStackManagerChildEnv = (
  deployment: Readonly<{
    rpcUrl: string;
    chainId: number;
    signerPrivateKeyHex: string;
    foundationRecipient: string;
    stablecoinAddress: string;
    deployTestStablecoin: boolean;
    outputPath: string;
    deploymentId: string;
    mode: 'new' | 'resume';
  }>,
): Record<string, string> => {
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
    XLN_DEPLOYMENT_ID: deployment.deploymentId,
    XLN_DEPLOYMENT_MODE: deployment.mode,
  };
};

export const probeJurisdictionStackTarget = async (
  request: Pick<DeployJurisdictionStackRequest, 'rpcUrl' | 'signerId'> & Readonly<{ expectedChainId?: number }>,
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

const runNativeTask = async (request: DeployJurisdictionStackRequest, options: StackDeploymentOptions, directory: string) => {
  const temporary = await mkdtemp(join(tmpdir(), 'xln-deploy-dispatch-'));
  const parameters = join(temporary, 'parameters.json');
  try {
    await writeFile(parameters, safeStringify({ chainId: request.expectedChainId, foundationRecipient: request.foundationRecipient,
      stablecoin: request.stablecoin, confirmations: request.confirmations }), { mode: 0o600 });
    const child = spawn('bunx', ['hardhat', 'xln-deploy', '--network', 'stack-manager', '--parameters', parameters,
      '--deployment-id', options.deploymentId, '--mode', options.mode, '--deployment-dir', directory], {
      cwd: new URL('../../../../jurisdictions', import.meta.url),
      env: buildStackManagerChildEnv({ rpcUrl: request.rpcUrl, chainId: request.expectedChainId,
        signerPrivateKeyHex: hexlify(options.signerPrivateKey), foundationRecipient: request.foundationRecipient,
        stablecoinAddress: request.stablecoin.kind === 'existing' ? request.stablecoin.address : '',
        deployTestStablecoin: request.stablecoin.kind === 'test', outputPath: join(directory, 'manifest.json'),
        deploymentId: options.deploymentId, mode: options.mode }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const observe = (data: Buffer): void => {
      const value = data.toString(); tail = (tail + value).slice(-65_536);
      if (value.includes('XLN_DEPLOY_PHASE:verifying')) options.onPhase?.('verifying');
    };
    child.stdout.on('data', observe); child.stderr.on('data', observe);
    const exit = await new Promise<number | null>((done, fail) => { child.once('error', fail); child.once('close', done); });
    if (exit !== 0) throw new Error(`STACK_MANAGER_HARDHAT_DEPLOY_FAILED:exit=${exit}:detail=${sanitizeDeploymentMessage(tail, hexlify(options.signerPrivateKey), request.rpcUrl)}`);
    const outcome: unknown = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
    if (!outcome || typeof outcome !== 'object' || !('status' in outcome) || outcome.status !== 'complete' || !('manifest' in outcome)) {
      throw new Error('STACK_MANAGER_NATIVE_RESULT_INVALID');
    }
    return decodeJurisdictionStackManifest(outcome.manifest);
  } finally { await rm(temporary, { recursive: true }); }
};

const checkCallerAuthority = (request: DeployJurisdictionStackRequest, options: StackDeploymentOptions): void => {
  const wallet = new Wallet(hexlify(options.signerPrivateKey));
  if (wallet.address.toLowerCase() !== request.signerId.toLowerCase()) throw new Error('STACK_MANAGER_SIGNER_KEY_MISMATCH');
  if (request.foundationRecipient.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('FOUNDATION_LISTING_SIGNER_MISMATCH');
  if (request.publication === 'official' && options.officialFoundationSignerId?.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error('FOUNDATION_PUBLICATION_AUTHORITY_UNAVAILABLE');
  }
};

export const deployJurisdictionStack = async (request: DeployJurisdictionStackRequest, options: StackDeploymentOptions): Promise<DeployJurisdictionStackResult> => {
  decodeStackManagerRpcUrl(request.rpcUrl);
  const execution = decodeStackDeploymentExecution({ deploymentId: options.deploymentId, mode: options.mode });
  if (execution.mode === 'resume') await assertStackDeploymentResumeExists(execution.deploymentId, options.evidenceDirectory);
  checkCallerAuthority(request, options);
  const base = resolve(options.evidenceDirectory || new URL('../../../../docs/evidence/stack-manager', import.meta.url).pathname);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = join(base, execution.deploymentId);
  const release = await acquireStackManagerDeploymentLock();
  try {
    options.onPhase?.('preflight');
    if (execution.mode === 'new') await assertJurisdictionStackKeyAvailable(request.key);
    const publishedRpc = execution.mode === 'resume'
      ? await readStackPublicationRpc(request, directory, execution.deploymentId) : undefined;
    if (execution.mode === 'resume') await assertStackResumeCatalogBinding(request, directory, execution.deploymentId, publishedRpc);
    options.onPhase?.('deploying');
    const manifest = await runNativeTask(request, options, directory);
    const advertisedRpc = publishedRpc || request.rpcUrl;
    const stablecoin = decodeRegisteredStackStablecoin(manifest.registeredTokens);
    const announcement = request.publication === 'local' ? undefined : createJurisdictionGossipAnnouncement({
      scope: request.publication, key: request.key, name: request.name, rpcUrl: advertisedRpc,
      blockTimeMs: request.blockTimeMs, currency: request.currency, explorer: request.explorer,
      ...(request.description ? { description: request.description } : {}), chainId: manifest.chainId,
      deployer: manifest.deployer, foundationRecipient: manifest.foundationRecipient,
      entityProviderDeploymentBlock: manifest.entityProviderDeploymentBlock, contracts: manifest.contracts, stablecoin,
    }, options.signerPrivateKey, options.officialFoundationSignerId);
    options.onPhase?.('persisting');
    await sealStackPublicationRpc(request, directory, execution.deploymentId, advertisedRpc);
    const { alreadyPresent, ...localJurisdiction } = await persistVerifiedJurisdictionStack({ ...request, rpcUrl: advertisedRpc }, manifest,
      announcement, options.officialFoundationSignerId, execution.mode === 'resume');
    const publication = !announcement ? { status: 'not_requested' as const, scope: 'local' as const }
      : { status: !alreadyPresent && options.publishJurisdiction?.(announcement) ? 'published' as const : 'queued' as const,
        scope: announcement.scope, announcement };
    options.onPhase?.('complete');
    return { manifest, localJurisdiction, publication };
  } finally { await release(); }
};
