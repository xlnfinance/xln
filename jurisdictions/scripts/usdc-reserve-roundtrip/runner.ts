import { FetchRequest, JsonRpcProvider, Wallet } from 'ethers';
import { generateLazyEntityId } from '../../../core/entity/factory';
import { Depository__factory } from '../../typechain-types';
import { sanitizeDeploymentMessage } from '../deployment/evidence.cjs';
import { receiptExpense } from '../deployment/operator/result';
import { requireBoundaryRecord } from '../../../core/protocol/boundary-validation';
import { validateRoundtripOptions } from './inputs';
import { captureProbeIdentity, verifyRoundtripDeployment } from './verification';
import { assertCleanFundedReserve, assertRoundtripDelta, readRoundtripBalances } from './balances';
import { approveRoundtrip, sendReserveOperation, verifyRoundtripReceipts } from './transactions';
import { ONE_USDC, type Context, type RoundtripEvidence, type RoundtripOptions, type Snapshot } from './types';

const rpcVariable = {
  local: 'XLN_STACK_MANAGER_RPC_URL',
  'ethereum-sepolia': 'ETH_SEPOLIA_RPC',
  'arbitrum-sepolia': 'ARB_SEPOLIA_RPC',
} as const;

const depositRoundtrip = async (context: Context): Promise<Snapshot> => {
  context.evidence.stage = 'preflight-balances';
  const initial = await readRoundtripBalances(context);
  context.evidence.snapshots.initial = initial;
  await assertCleanFundedReserve(context, initial);
  if (initial.allowance < ONE_USDC) await approveRoundtrip(context);
  await sendReserveOperation(context, 'deposit');
  context.evidence.stage = 'deposit-balances';
  const deposited = await readRoundtripBalances(context);
  context.evidence.snapshots.deposited = deposited;
  assertRoundtripDelta(initial, deposited, true);
  return initial;
};

const reconcileNative = (context: Context, initial: Snapshot, restored: Snapshot): void => {
  const feesWei = context.evidence.transactions.reduce((sum, item) => {
    const expense = requireBoundaryRecord(item.expense, 'USDC_ROUNDTRIP_EXPENSE_MISSING');
    return sum + BigInt(String(expense['feeWei']));
  }, 0n);
  const deltaWei = initial.nativeWei - restored.nativeWei;
  context.evidence.native = { feesWei, deltaWei, unaccountedDeltaWei: deltaWei - feesWei };
  if (deltaWei !== feesWei) throw new Error('USDC_ROUNDTRIP_NATIVE_CONSERVATION_MISMATCH');
};

const executeRoundtrip = async (context: Context): Promise<void> => {
  const initial = await depositRoundtrip(context);
  await sendReserveOperation(context, 'withdrawal');
  context.evidence.stage = 'restoration-balances';
  const restored = await readRoundtripBalances(context);
  context.evidence.snapshots.restored = restored;
  assertRoundtripDelta(initial, restored, false);
  reconcileNative(context, initial, restored);
  context.evidence.stage = 'final-verification';
  await verifyRoundtripReceipts(context, restored.point);
  context.signal.throwIfAborted();
  context.evidence.stage = 'complete';
  context.evidence.status = 'complete';
};

const captureFailure = async (context: Context, sanitize: (message: string) => string): Promise<void> => {
  if (context.signal.aborted) {
    context.evidence.balanceReadFailure = 'USDC_ROUNDTRIP_DEADLINE_EXCEEDED';
    return;
  }
  try {
    context.evidence.snapshots.failure = await readRoundtripBalances(context);
  } catch (error) {
    context.evidence.balanceReadFailure = sanitize(error instanceof Error ? error.message : String(error));
  }
  for (const entry of context.evidence.transactions) {
    if (entry.receipt) continue;
    try {
      entry.receipt = await context.provider.send('eth_getTransactionReceipt', [entry.hash]);
      entry.expense = await receiptExpense(context.provider, entry.hash);
    } catch (error) {
      context.evidence.balanceReadFailure = sanitize(error instanceof Error ? error.message : String(error));
    }
  }
};

const createContext = async (
  options: RoundtripOptions,
  provider: JsonRpcProvider,
  wallet: Wallet,
  evidence: RoundtripEvidence,
  signal: AbortSignal,
) => {
  signal.throwIfAborted();
  const verified = await verifyRoundtripDeployment(options, provider);
  signal.throwIfAborted();
  evidence.confirmations = verified.confirmations;
  evidence.deployment = {
    deploymentId: verified.input.manifest.deploymentId,
    manifest: verified.input.manifest,
    executionCandidate: verified.input.executionCandidate,
    inputDigests: verified.input.inputDigests,
    verifiedAt: verified.point,
  };
  const entityId = generateLazyEntityId([wallet.address], 1n);
  evidence.signer = wallet.address;
  evidence.entityId = entityId;
  const depository = Depository__factory.connect(verified.input.manifest.contracts.depository, wallet);
  return { options, provider, wallet, input: verified.input, depository, entityId, evidence, signal } satisfies Context;
};

const startDeadline = (provider: JsonRpcProvider) => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('USDC_ROUNDTRIP_DEADLINE_EXCEEDED');
      controller.abort(error);
      provider.destroy();
      reject(error);
    }, 600_000);
  });
  return {
    expiry,
    signal: controller.signal,
    close: () => {
      clearTimeout(timer);
      controller.abort();
      provider.destroy();
    },
  };
};

const runAttempt = async (
  options: RoundtripOptions,
  provider: JsonRpcProvider,
  wallet: Wallet,
  evidence: RoundtripEvidence,
  sanitize: (message: string) => string,
): Promise<void> => {
  const deadline = startDeadline(provider);
  let context: Context | undefined;
  const operation = createContext(options, provider, wallet, evidence, deadline.signal).then(async value => {
    context = value;
    await executeRoundtrip(value);
  });
  try {
    await Promise.race([operation, deadline.expiry]);
  } catch (error) {
    evidence.failure = sanitize(error instanceof Error ? error.message : String(error));
    if (context) await captureFailure(context, sanitize);
  } finally {
    deadline.close();
  }
};

const providerFor = (rpc: string): JsonRpcProvider => {
  const request = new FetchRequest(rpc);
  request.timeout = 10_000;
  request.retryFunc = async () => false;
  const provider = new JsonRpcProvider(request, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 250;
  return provider;
};

export const runUsdcReserveRoundtrip = async (requested: RoundtripOptions): Promise<RoundtripEvidence> => {
  const secret = String(process.env['DEPLOYER_PRIVATE_KEY'] || '').trim();
  const rpc = String(process.env[rpcVariable[requested.network]] || '').trim();
  const evidence: RoundtripEvidence = {
    operation: 'one-usdc-reserve-roundtrip',
    status: 'incomplete',
    stage: 'preflight-deployment',
    network: requested.network,
    chainId: requested.chainId,
    amount: ONE_USDC,
    confirmations: requested.confirmations ?? 12,
    transactions: [],
    snapshots: {},
  };
  const sanitize = (message: string) => sanitizeDeploymentMessage(message, secret, rpc);
  try {
    evidence.probe = await captureProbeIdentity();
    const options = validateRoundtripOptions(requested, rpc);
    if (!/^0x[0-9a-f]{64}$/i.test(secret)) throw new Error('USDC_ROUNDTRIP_PRIVATE_KEY_REQUIRED');
    const provider = providerFor(rpc);
    await runAttempt(options, provider, new Wallet(secret, provider), evidence, sanitize);
  } catch (error) {
    evidence.failure = sanitize(error instanceof Error ? error.message : String(error));
  }
  return evidence;
};
