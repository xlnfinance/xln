import type { HardhatRuntimeEnvironment } from 'hardhat/types/hre';
import { FetchRequest, JsonRpcProvider } from 'ethers';
import { realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  candidateRevision,
  captureCandidateSources,
  deploymentErrorCode,
  sanitizeDeploymentMessage,
} from '../evidence.cjs';
import { verifyOrigin } from '../origin.cjs';
import { safeStringify } from '../../../../core/protocol/serialization/index.ts';
import { verifyJurisdictionStack } from '../../../../core/jurisdiction/adapter/stack-manager/verification.ts';
import {
  assertCanonicalChainPoint,
  readCanonicalChainPoint,
} from '../../../../core/jurisdiction/adapter/stack-manager/receipts.ts';
import {
  assertVerificationInputsUnchanged,
  readVerificationInputs,
  verificationOutputPath,
} from './readonly-identity.ts';
import { verifyReadonlyJournal } from './readonly-journal.ts';
import { readDeploymentExpenses } from './result.ts';

export type VerificationArguments = Readonly<{ deploymentDir: string | undefined; output: string | undefined }>;

const readMethods = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getTransactionCount',
  'eth_getBalance',
  'eth_getCode',
  'eth_call',
]);

// This operation has no signing authority: reject every method outside the
// exact read surface before transport, including eth_send*, eth_sign and wallet_*.
class ReadonlyProvider extends JsonRpcProvider {
  override send(method: string, params: Array<unknown> | Record<string, unknown>): Promise<unknown> {
    if (!readMethods.has(method)) throw new Error(`XLN_VERIFY_RPC_METHOD_FORBIDDEN:${method}`);
    return super.send(method, params);
  }
}

const verifyExisting = async (input: Awaited<ReturnType<typeof readVerificationInputs>>, provider: JsonRpcProvider) => {
  const point = await readCanonicalChainPoint(provider);
  try {
    await verifyOrigin(input.identity.origin, provider, input.deployer);
    const operations = await verifyReadonlyJournal(input, provider);
    await verifyJurisdictionStack(provider, input.manifest, input.confirmations, point.number, input.artifactsRoot);
    const expenses = await readDeploymentExpenses(input, provider, point);
    await assertVerificationInputsUnchanged(input);
    await assertCanonicalChainPoint(provider, point);
    return {
      schemaVersion: 1,
      operation: 'read-only-existing-stack-verification',
      status: 'verified',
      deploymentId: input.manifest.deploymentId,
      chainId: input.manifest.chainId,
      executionCandidate: input.executionCandidate,
      verificationCandidate: { ...candidateRevision(), sources: captureCandidateSources() },
      manifest: input.manifest,
      inputDigests: input.inputDigests,
      point,
      checks: {
        originalCommittedSources: true,
        sealedArtifactSnapshot: true,
        nativeIdentityAndOperations: operations,
        canonicalNativeReceipts: true,
        origin: true,
        exactBytecode: true,
        constructorsAndBindings: true,
        foundationAndToken: true,
        admissionConfirmations: input.confirmations,
      },
      currentOperation: { signatures: 0, broadcasts: 0 },
      deploymentExpenses: expenses,
    };
  } catch (error) {
    await assertCanonicalChainPoint(provider, point);
    throw error;
  }
};

const boundedVerification = async (input: Awaited<ReturnType<typeof readVerificationInputs>>, rpcUrl: string) => {
  const request = new FetchRequest(rpcUrl);
  request.timeout = 10_000;
  const provider = new ReadonlyProvider(request, input.manifest.chainId, { cacheTimeout: -1 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('XLN_VERIFY_DEADLINE_EXCEEDED')), 60_000);
  });
  try {
    return await Promise.race([verifyExisting(input, provider), timeout]);
  } finally {
    clearTimeout(timer);
    provider.destroy();
  }
};

export const runReadonlyVerification = async (
  args: VerificationArguments,
  hre: HardhatRuntimeEnvironment,
): Promise<void> => {
  let rpcUrl = '';
  try {
    if (!args.deploymentDir) throw new Error('XLN_VERIFY_DEPLOYMENT_DIRECTORY_REQUIRED');
    const directory = await realpath(resolve(args.deploymentDir));
    const output = await verificationOutputPath(directory, args.output);
    const input = await readVerificationInputs(directory);
    const network = hre.config.networks[hre.globalOptions.network];
    if (!network || network.type !== 'http') throw new Error('XLN_VERIFY_HTTP_NETWORK_REQUIRED');
    if (network.chainId !== undefined && network.chainId !== input.manifest.chainId)
      throw new Error('XLN_VERIFY_NETWORK_CHAIN_MISMATCH');
    rpcUrl = await network.url.getUrl();
    const report = await boundedVerification(input, rpcUrl);
    const json = `${safeStringify(report, 2)}\n`;
    if (output) await writeFile(output, json, { flag: 'wx', mode: 0o600 });
    process.stdout.write(json);
  } catch (error) {
    const message = sanitizeDeploymentMessage(
      error instanceof Error ? error.message : String(error),
      process.env['DEPLOYER_PRIVATE_KEY'] || '',
      rpcUrl,
    );
    process.stderr.write(`XLN_VERIFY_FAILED:${deploymentErrorCode(error)}:${message}\n`);
    process.exitCode = 1;
  }
};
