import type { RuntimeReplica } from '../runtime/types';
import type { EntityInput, EntityReplica } from '../entity/types';
import type { Delta } from '../types/account';
import type { FrameLogEntry } from '../types/logging';
import type { JAdapter, JTokenInfo } from '../jurisdiction/adapter/types';
import { deriveDelta, isLeftEntity } from '../account/utils';
import { createEmptyBatch, batchAddReserveToReserve } from '../jurisdiction/machine/batch';
import { formatRuntime } from '../qa/runtime-ascii';
import { advanceScenarioTime } from './helpers';
import { submitSignedScenarioBatch } from './j-batch-submit';
import { DEFAULT_TOKENS } from '../jurisdiction/machine/default-tokens';

type ProcessFn = (env: RuntimeReplica, inputs?: EntityInput[], delay?: number, single?: boolean) => Promise<RuntimeReplica>;

// Lazy-loaded runtime function avoids the scenario -> runtime -> scenario import cycle.
let cachedProcess: ProcessFn | null = null;

export const getProcess = async (): Promise<ProcessFn> => {
  if (!cachedProcess) {
    const runtime = await import('../runtime');
    cachedProcess = runtime.processRuntime;
  }
  return cachedProcess;
};

export const USDC_TOKEN_ID = 1;
export const DECIMALS = BigInt(DEFAULT_TOKENS[USDC_TOKEN_ID - 1]!.decimals);
export const ONE_TOKEN = 10n ** DECIMALS;
export const AHB_JURISDICTION = 'AHB Demo';

type ExternalTokenToReserveOptions = NonNullable<Parameters<JAdapter['externalTokenToReserve']>[4]>;
export type SnapshotLogs = { logs?: FrameLogEntry[]; frameLogs?: FrameLogEntry[] };

export type RequiredBrowserVM = {
  getReserves: (entityId: string, tokenId: number) => Promise<bigint>;
  externalTokenToReserve: (privKey: Uint8Array, entityId: string, tokenAddress: string, amount: bigint, opts?: ExternalTokenToReserveOptions) => Promise<unknown[]>;
  getBlockNumber: () => bigint;
  getBlockHash: () => string;
  getChainId: () => bigint;
  getDepositoryAddress: () => string;
  getEntityProviderAddress: () => string;
  getEntityNonce: (entityId: string) => Promise<bigint>;
  getAccountInfo: (entityId: string, counterpartyId: string) => Promise<{ nonce: bigint; disputeHash: string; disputeTimeout: bigint }>;
  onAny: (callback: (events: unknown[]) => void) => () => void;
  getTokenRegistry: () => JTokenInfo[];
  getTokenAddress: (symbol: string) => string | null;
  fundSignerWallet: (address: string, amount?: bigint) => Promise<void>;
  approveErc20: JAdapter['approveErc20'];
  reserveToReserve?: (from: string, to: string, tokenId: number, amount: bigint) => Promise<unknown[]>;
  debugFundReserves?: (entityId: string, tokenId: number, amount: bigint) => Promise<unknown[]>;
  captureStateRoot?: () => Promise<Uint8Array>;
  timeTravel?: (stateRoot: Uint8Array) => Promise<void>;
  processBatch?: (encodedBatch: string, hankoData: string, nonce: bigint) => Promise<unknown[]>;
};

const isBrowser = typeof window !== 'undefined';
const getEnv = (key: string, defaultVal: string): string =>
  isBrowser ? defaultVal : (typeof process !== 'undefined' ? process.env[key] || defaultVal : defaultVal);

export const AHB_STRESS = getEnv('AHB_STRESS', '0') === '1';
export const AHB_STRESS_ITERS = Number.parseInt(getEnv('AHB_STRESS_ITERS', '100'), 10);
export const AHB_STRESS_AMOUNT_USD = Number.parseInt(getEnv('AHB_STRESS_AMOUNT', '1'), 10);
export const AHB_STRESS_DRAIN_EVERY = Number.parseInt(getEnv('AHB_STRESS_DRAIN_EVERY', '0'), 10);
export const AHB_DEBUG = getEnv('AHB_DEBUG', '0') === '1';

export const usd = (amount: number | bigint): bigint => BigInt(amount) * ONE_TOKEN;

export async function submitReserveToReserveBatch(
  env: RuntimeReplica,
  jadapter: JAdapter,
  signerId: string,
  fromEntityId: string,
  toEntityId: string,
  tokenId: number,
  amount: bigint,
): Promise<void> {
  const batch = createEmptyBatch();
  batchAddReserveToReserve(
    { batch, jurisdiction: null, lastBroadcast: 0, broadcastCount: 0, failedAttempts: 0, status: 'empty' },
    toEntityId,
    tokenId,
    amount,
  );
  await submitSignedScenarioBatch(env, jadapter, fromEntityId, signerId, batch, 'AHB R2R batch');
}

type ReplicaEntry = [string, EntityReplica];

export function findReplica(env: RuntimeReplica, entityId: string): ReplicaEntry {
  const entry = Array.from(env.state.eReplicas.entries()).find(([key]) => key.startsWith(entityId + ':'));
  if (!entry) {
    throw new Error(`AHB: Replica for entity ${entityId} not found`);
  }
  return entry as ReplicaEntry;
}

export function assert(condition: unknown, message: string, env?: RuntimeReplica): asserts condition {
  if (!condition) {
    if (env) {
      console.log('\n' + '='.repeat(80));
      console.log('ASSERTION FAILED - FULL RUNTIME STATE:');
      console.log('='.repeat(80));
      console.log(formatRuntime(env, { maxAccounts: 5, maxLocks: 20 }));
      console.log('='.repeat(80) + '\n');
    }
    throw new Error(`ASSERT: ${message}`);
  }
}

export function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function hasExpectedDirection(actual: bigint, expected: bigint): boolean {
  if (actual === 0n || expected === 0n) return actual === expected;
  return (actual > 0n) === (expected > 0n);
}

export function getDerivedOutCapacity(env: RuntimeReplica, entityId: string, counterpartyId: string, tokenId: number): bigint {
  const [, replica] = findReplica(env, entityId);
  const account = replica.state.accounts.get(counterpartyId);
  const delta = account?.state.deltas.get(tokenId);
  if (!delta) return 0n;
  return deriveDelta(delta, isLeftEntity(entityId, counterpartyId)).outCapacity;
}

/**
 * Drain BrowserVM-originated J events through normal R->E->A routing.
 *
 * The scenario intentionally does not mutate entity state after BrowserVM work.
 * BrowserVM emits events, the watcher queues entity inputs, and this helper lets
 * the runtime process those inputs like any other jurisdiction observation.
 */
export async function processJEvents(env: RuntimeReplica): Promise<void> {
  const processRuntime = await getProcess();
  const { getScenarioJAdapter, isScenarioJAdapterMissingError } = await import('./boot');
  let jadapter;
  try {
    jadapter = getScenarioJAdapter(env);
  } catch (error) {
    if (!isScenarioJAdapterMissingError(error)) throw error;
  }
  if (typeof jadapter?.pollNow === 'function') {
    await jadapter.pollNow();
  }
  const pendingInputs = env.runtimeMempool?.entityInputs || [];
  if (!env.quietRuntimeLogs) {
    console.log(`🔄 processJEvents CALLED: ${pendingInputs.length} pending in queue`);
  }
  if (pendingInputs.length > 0) {
    if (!env.quietRuntimeLogs) {
      console.log(`   routing ${pendingInputs.length} to entities...`);
    }
    const toProcess = [...pendingInputs];
    env.runtimeMempool.entityInputs = [];
    await processRuntime(env, toProcess);
    if (!env.quietRuntimeLogs) {
      console.log(`   ✓ ${toProcess.length} j-events processed`);
    }
  } else if (!env.quietRuntimeLogs) {
    console.log(`   ⚠️ EMPTY queue - no j-events to process`);
  }
}

export async function maybeApproveSettlement(
  env: RuntimeReplica,
  approver: { id: string; signer: string; name: string },
  counterpartyId: string,
): Promise<boolean> {
  await processUntil(env, () => {
    const [, approverReplica] = findReplica(env, approver.id);
    const account = approverReplica.state.accounts.get(counterpartyId);
    return !account?.mempool.some((tx) => tx.type === 'settle_transition') &&
      !account?.pendingFrame?.accountTxs.some((tx) => tx.type === 'settle_transition');
  }, 20, `${approver.name} settlement proposal delivery`);

  const [, approverRep] = findReplica(env, approver.id);
  const account = approverRep.state.accounts.get(counterpartyId);
  const workspace = account?.state.settlementWorkspace;
  if (!workspace) throw new Error(`SETTLEMENT_WORKSPACE_MISSING:${approver.id}:${counterpartyId}`);
  const approverIsLeft = isLeftEntity(approver.id, counterpartyId);
  const myHanko = approverIsLeft ? workspace.leftHanko : workspace.rightHanko;
  let approved = false;
  if (myHanko) {
    console.log(`ℹ️ ${approver.name} already signed settlement with ${counterpartyId.slice(-4)} (skip duplicate settle_approve)`);
  } else {
    const processRuntime = await getProcess();
    await processRuntime(env, [{
      entityId: approver.id,
      signerId: approver.signer,
      entityTxs: [{
        type: 'settle_approve',
        data: { counterpartyEntityId: counterpartyId, workspaceHash: workspace.workspaceHash },
      }],
    }]);
    approved = true;
  }

  await processUntil(env, () => {
    const [, counterpartyReplica] = findReplica(env, counterpartyId);
    return counterpartyReplica.state.accounts.get(approver.id)?.state.settlementWorkspace?.status === 'ready_to_submit';
  }, 20, `${approver.name} settlement approval delivery`);
  return approved;
}

export async function processUntil(
  env: RuntimeReplica,
  predicate: () => boolean,
  maxRounds: number = 10,
  label: string = 'condition'
): Promise<void> {
  const processRuntime = await getProcess();
  for (let round = 0; round < maxRounds; round++) {
    if (predicate()) return;
    await processRuntime(env);
    advanceScenarioTime(env);
  }
  if (!predicate()) {
    throw new Error(`processUntil: ${label} not satisfied after ${maxRounds} rounds`);
  }
}

// Account deltas are stored canonically from the lower entity id's perspective.
export function getOffdelta(env: RuntimeReplica, entityA: string, entityB: string, tokenId: number): bigint {
  const leftEntity = isLeftEntity(entityA, entityB) ? entityA : entityB;
  const rightEntity = isLeftEntity(entityA, entityB) ? entityB : entityA;

  const [, leftReplica] = findReplica(env, leftEntity);
  const account = leftReplica.state.accounts.get(rightEntity);
  if (!account) return 0n;

  const delta = account.state.deltas.get(tokenId);
  return delta?.offdelta ?? 0n;
}

export function assertBilateralSync(env: RuntimeReplica, entityA: string, entityB: string, tokenId: number, label: string): void {
  const [, replicaA] = findReplica(env, entityA);
  const [, replicaB] = findReplica(env, entityB);

  console.log(`\n[BILATERAL-SYNC ${label}] Checking ${entityA.slice(-4)}←→${entityB.slice(-4)} for token ${tokenId}...`);

  const accountFromA = replicaA.state.accounts.get(entityB);
  const accountFromB = replicaB.state.accounts.get(entityA);
  if (!accountFromA) {
    console.error(`❌ Entity ${entityA.slice(-4)} has NO account with counterparty ${entityB.slice(-4)}`);
    throw new Error(`BILATERAL-SYNC FAIL at "${label}": Entity ${entityA.slice(-4)} missing account`);
  }
  if (!accountFromB) {
    console.error(`❌ Entity ${entityB.slice(-4)} has NO account with counterparty ${entityA.slice(-4)}`);
    throw new Error(`BILATERAL-SYNC FAIL at "${label}": Entity ${entityB.slice(-4)} missing account`);
  }

  const deltaFromA = accountFromA.state.deltas?.get(tokenId);
  const deltaFromB = accountFromB.state.deltas?.get(tokenId);
  if (!deltaFromA) {
    console.error(`❌ Entity ${entityA.slice(-4)} account has NO delta for token ${tokenId}`);
    throw new Error(`BILATERAL-SYNC FAIL at "${label}": Entity ${entityA.slice(-4)} missing delta for token ${tokenId}`);
  }
  if (!deltaFromB) {
    console.error(`❌ Entity ${entityB.slice(-4)} account has NO delta for token ${tokenId}`);
    throw new Error(`BILATERAL-SYNC FAIL at "${label}": Entity ${entityB.slice(-4)} missing delta for token ${tokenId}`);
  }

  const fieldsToCheck: Array<keyof Delta> = [
    'collateral',
    'ondelta',
    'offdelta',
    'leftCreditLimit',
    'rightCreditLimit',
    'leftAllowance',
    'rightAllowance',
  ];

  const errors: string[] = [];
  for (const field of fieldsToCheck) {
    const valueAB = deltaFromA[field];
    const valueBA = deltaFromB[field];
    if (valueAB !== valueBA) {
      const msg = `  ${field}: ${entityA.slice(-4)} has ${valueAB}, ${entityB.slice(-4)} has ${valueBA}`;
      console.error(`❌ ${msg}`);
      errors.push(msg);
    }
  }

  if (errors.length > 0) {
    console.error(`\n❌ BILATERAL-SYNC FAILED at "${label}":`);
    console.error(`   Account: ${entityA.slice(-4)}←→${entityB.slice(-4)}, token ${tokenId}`);
    console.error(`   Mismatched fields:\n${errors.join('\n')}`);
    console.error(`\n   Full deltaFromA (${entityA.slice(-4)} view):`, deltaFromA);
    console.error(`   Full deltaFromB (${entityB.slice(-4)} view):`, deltaFromB);
    throw new Error(`BILATERAL-SYNC VIOLATION: ${errors.length} field(s) differ between ${entityA.slice(-4)} and ${entityB.slice(-4)}`);
  }

  console.log(`✅ [${label}] Bilateral sync OK: ${entityA.slice(-4)}←→${entityB.slice(-4)} token ${tokenId} - all ${fieldsToCheck.length} fields match`);
}
