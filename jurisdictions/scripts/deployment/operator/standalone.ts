import type { HardhatRuntimeEnvironment } from 'hardhat/types/hre';
import type { NetworkConnection } from 'hardhat/types/network';
import { JsonRpcProvider, Wallet } from 'ethers';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { executeStack } from '../../deploy-stack.cjs';
import { prepareExecution } from '../preflight.cjs';
import { sanitizeDeploymentMessage, deploymentErrorCode, candidateRevision } from '../evidence.cjs';
import { decodeJurisdictionStackManifest } from '../../../../core/jurisdiction/adapter/stack-manager/validation.ts';
import { verifyJurisdictionStack } from '../../../../core/jurisdiction/adapter/stack-manager/verification.ts';
import { safeStringify } from '../../../../core/protocol/serialization/index.ts';
import { decodeDeploymentIntent, decodeDeploymentParameters, type DeploymentArguments } from './inputs.ts';
import { acquireDeploymentLane, createInvocation } from './attempt.ts';
import { readDeploymentExpenses } from './result.ts';
import { readCanonicalChainPoint, assertCanonicalChainPoint } from '../../../../core/jurisdiction/adapter/stack-manager/receipts.ts';
import { assertNativeReceipts } from '../receipts.cjs';

const readInputs = async (args: DeploymentArguments) => {
  const intent = decodeDeploymentIntent(args);
  const parameters = decodeDeploymentParameters(JSON.parse(await readFile(intent.parameters, 'utf8')));
  const secret = process.env['DEPLOYER_PRIVATE_KEY'] || '';
  if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(secret)) throw new Error('DEPLOYER_PRIVATE_KEY_REQUIRED');
  return { intent, parameters, signer: new Wallet(secret.startsWith('0x') ? secret : `0x${secret}`) };
};
type Inputs = Awaited<ReturnType<typeof readInputs>>;
type Attempt = Awaited<ReturnType<typeof prepareExecution>>;

const prepareNative = async (input: Inputs, hre: HardhatRuntimeEnvironment, connection: NetworkConnection, directory: string) => {
  await hre.tasks.getTask('compile').run({});
  return prepareExecution({ ethers: connection.ethers, artifacts: hre.artifacts, config: hre.config, networkConfig: connection.networkConfig, input: {
    XLN_DEPLOYMENT_ID: input.intent.deploymentId, XLN_DEPLOYMENT_MODE: input.intent.mode, XLN_DEPLOY_OUTPUT: join(directory, 'manifest.json'),
    nativeDirectory: directory, DEPLOYER_PRIVATE_KEY: input.signer.privateKey,
    XLN_FOUNDATION_ADDRESS: input.parameters.foundationRecipient || input.signer.address,
    XLN_STACK_MANAGER_CHAIN_ID: String(input.parameters.chainId), XLN_DEPLOY_CONFIRMATIONS: String(input.parameters.confirmations),
    XLN_STABLECOIN_ADDRESS: input.parameters.stablecoin.kind === 'existing' ? input.parameters.stablecoin.address : '',
    XLN_DEPLOY_TEST_STABLECOIN: input.parameters.stablecoin.kind === 'test' ? '1' : '0',
  } });
};

const failureDetails = (error: unknown, secret: string, rpcUrl: string) => ({ code: deploymentErrorCode(error),
  message: sanitizeDeploymentMessage(error instanceof Error ? error.message : String(error), secret, rpcUrl) });

const recordFailure = async (invocation: Awaited<ReturnType<typeof createInvocation>>, error: unknown,
  attempt: Attempt, provider: JsonRpcProvider, rpcUrl: string, phase: string): Promise<void> => {
  let expenses: unknown;
  try { expenses = await readDeploymentExpenses(attempt, provider); }
  catch (expenseError) { expenses = { coverage: 'unavailable', error: failureDetails(expenseError, attempt.privateKey, rpcUrl) }; }
  invocation.write({ status: 'failed', phase, expenses, error: failureDetails(error, attempt.privateKey, rpcUrl) });
};

const deployAndVerify = async (input: Inputs, hre: HardhatRuntimeEnvironment, connection: NetworkConnection, attempt: Attempt, rpcUrl: string) => {
  const invocation = await createInvocation(attempt.directory, { ...attempt.identity, mode: input.intent.mode, candidate: candidateRevision() });
  const provider = new JsonRpcProvider(rpcUrl, input.parameters.chainId, { cacheTimeout: -1, pollingInterval: 100 });
  let phase = 'deploying';
  try {
    const manifest = decodeJurisdictionStackManifest(await executeStack({ connection, artifacts: hre.artifacts, config: hre.config, attempt }));
    phase = 'verifying';
    invocation.write({ status: 'running', phase: 'verifying' });
    process.stderr.write('XLN_DEPLOY_PHASE:verifying\n');
    await verifyJurisdictionStack(provider, manifest, input.parameters.confirmations);
    const point = await readCanonicalChainPoint(provider);
    let expenses;
    try {
      await verifyJurisdictionStack(provider, manifest, input.parameters.confirmations, point.number);
      await assertNativeReceipts(attempt.journalDirectory, provider);
      expenses = await readDeploymentExpenses(attempt, provider, point);
    } catch (error) { await assertCanonicalChainPoint(provider, point); throw error; }
    // Every state read and balance belongs to this block. A reorg anywhere
    // before terminal publication invalidates the whole observation, not just
    // whichever receipt happened to be read last.
    await assertCanonicalChainPoint(provider, point);
    const result = { status: 'complete', phase: 'complete', manifest, expenses,
      verification: { exactBytecode: true, constructorsAndBindings: true, foundationAndToken: true, confirmations: input.parameters.confirmations, point },
      artifacts: { directory: attempt.directory, journal: join(attempt.directory, 'journal.jsonl'), manifest: attempt.output, candidate: `${attempt.output}.artifacts` } };
    invocation.write(result);
    process.stdout.write(`${safeStringify(result, 2)}\n`);
  } catch (error) {
    await recordFailure(invocation, error, attempt, provider, rpcUrl, phase);
    throw error;
  } finally { provider.destroy(); }
};

export const runStandaloneDeployment = async (args: DeploymentArguments, hre: HardhatRuntimeEnvironment): Promise<void> => {
  const secret = process.env['DEPLOYER_PRIVATE_KEY'] || '';
  let rpcUrl = '';
  try {
    const input = await readInputs(args);
    const connection = await hre.network.create();
    try {
      if (connection.networkConfig.type !== 'http') throw new Error('XLN_DEPLOY_DURABLE_HTTP_NETWORK_REQUIRED');
      rpcUrl = await connection.networkConfig.url.getUrl();
      const directory = resolve(args.deploymentDir || join(hre.config.paths.ignition, 'deployments', input.intent.deploymentId));
      const release = await acquireDeploymentLane(join(hre.config.paths.root, '.xln-deployment-locks'),
        input.parameters.chainId, input.signer.address, input.intent.deploymentId);
      try {
        const attempt = await prepareNative(input, hre, connection, directory);
        await deployAndVerify(input, hre, connection, attempt, rpcUrl);
      } finally { await release(); }
    } finally { await connection.close(); }
  } catch (error) {
    const failure = failureDetails(error, secret, rpcUrl);
    process.stderr.write(`XLN_DEPLOY_FAILED:${failure.code}:${failure.message}\n`);
    process.exitCode = 1;
  }
};
