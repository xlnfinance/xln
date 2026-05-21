import type { Env, EntityInput, EntityReplica, Delta, FrameLogEntry, JTx } from '../types';
import type { JAdapter, JTokenInfo } from '../jadapter/types';
import { deriveDelta, isLeft } from '../account-utils';
import { createEmptyBatch, batchAddReserveToReserve, getBatchSize } from '../j-batch';
import { formatRuntime } from '../runtime-ascii';
import { advanceScenarioTime } from './helpers';

type ProcessFn = (env: Env, inputs?: EntityInput[], delay?: number, single?: boolean) => Promise<Env>;

// Lazy-loaded runtime function avoids the scenario -> runtime -> scenario import cycle.
let cachedProcess: ProcessFn | null = null;

export const getProcess = async (): Promise<ProcessFn> => {
  if (!cachedProcess) {
    const runtime = await import('../runtime');
    cachedProcess = runtime.process;
  }
  return cachedProcess;
};

export const USDC_TOKEN_ID = 1;
export const DECIMALS = 18n;
export const ONE_TOKEN = 10n ** DECIMALS;
export const AHB_JURISDICTION = 'AHB Demo';

export type ExternalTokenToReserveOptions = NonNullable<Parameters<JAdapter['externalTokenToReserve']>[4]>;
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
  approveErc20: (privKey: Uint8Array, tokenAddress: string, spender: string, amount: bigint) => Promise<string>;
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
  env: Env,
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
  const jTx: JTx = {
    type: 'batch',
    entityId: fromEntityId,
    data: {
      batch,
      batchSize: getBatchSize(batch),
      signerId,
    },
    timestamp: env.timestamp,
  };
  const result = await jadapter.submitTx(jTx, { env, signerId, timestamp: env.timestamp });
  if (!result.success) {
    throw new Error(result.error || 'AHB R2R batch failed');
  }
}

type ReplicaEntry = [string, EntityReplica];

export function findReplica(env: Env, entityId: string): ReplicaEntry {
  const entry = Array.from(env.eReplicas.entries()).find(([key]) => key.startsWith(entityId + ':'));
  if (!entry) {
    throw new Error(`AHB: Replica for entity ${entityId} not found`);
  }
  return entry as ReplicaEntry;
}

export function assert(condition: unknown, message: string, env?: Env): asserts condition {
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

export function getDerivedOutCapacity(env: Env, entityId: string, counterpartyId: string, tokenId: number): bigint {
  const [, replica] = findReplica(env, entityId);
  const account = replica.state.accounts.get(counterpartyId);
  const delta = account?.deltas.get(tokenId);
  if (!delta) return 0n;
  return deriveDelta(delta, isLeft(entityId, counterpartyId)).outCapacity;
}

/**
 * Drain BrowserVM-originated J events through normal R->E->A routing.
 *
 * The scenario intentionally does not mutate entity state after BrowserVM work.
 * BrowserVM emits events, the watcher queues entity inputs, and this helper lets
 * the runtime process those inputs like any other jurisdiction observation.
 */
export async function processJEvents(env: Env): Promise<void> {
  const processRuntime = await getProcess();
  try {
    const { getScenarioJAdapter } = await import('./boot');
    const jadapter = getScenarioJAdapter(env);
    if (typeof jadapter.pollNow === 'function') {
      await jadapter.pollNow();
    }
  } catch {
    // Scenario may call this before adapter is attached.
  }
  const pendingInputs = env.runtimeInput?.entityInputs || [];
  if (!env.quietRuntimeLogs) {
    console.log(`🔄 processJEvents CALLED: ${pendingInputs.length} pending in queue`);
  }
  if (pendingInputs.length > 0) {
    if (!env.quietRuntimeLogs) {
      console.log(`   routing ${pendingInputs.length} to entities...`);
    }
    const toProcess = [...pendingInputs];
    env.runtimeInput.entityInputs = [];
    await processRuntime(env, toProcess);
    if (!env.quietRuntimeLogs) {
      console.log(`   ✓ ${toProcess.length} j-events processed`);
    }
  } else if (!env.quietRuntimeLogs) {
    console.log(`   ⚠️ EMPTY queue - no j-events to process`);
  }
}

export async function maybeApproveSettlement(
  env: Env,
  approver: { id: string; signer: string; name: string },
  counterpartyId: string,
): Promise<boolean> {
  const [, approverRep] = findReplica(env, approver.id);
  const account = approverRep.state.accounts.get(counterpartyId);
  const workspace = account?.settlementWorkspace;
  if (workspace) {
    const approverIsLeft = isLeft(approver.id, counterpartyId);
    const myHanko = approverIsLeft ? workspace.leftHanko : workspace.rightHanko;
    if (myHanko) {
      console.log(`ℹ️ ${approver.name} already signed settlement with ${counterpartyId.slice(-4)} (skip duplicate settle_approve)`);
      return false;
    }
  }

  const processRuntime = await getProcess();
  await processRuntime(env, [{
    entityId: approver.id,
    signerId: approver.signer,
    entityTxs: [{
      type: 'settle_approve',
      data: { counterpartyEntityId: counterpartyId },
    }],
  }]);
  return true;
}

export async function processUntil(
  env: Env,
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
export function getOffdelta(env: Env, entityA: string, entityB: string, tokenId: number): bigint {
  const leftEntity = isLeft(entityA, entityB) ? entityA : entityB;
  const rightEntity = isLeft(entityA, entityB) ? entityB : entityA;

  const [, leftReplica] = findReplica(env, leftEntity);
  const account = leftReplica.state.accounts.get(rightEntity);
  if (!account) return 0n;

  const delta = account.deltas.get(tokenId);
  return delta?.offdelta ?? 0n;
}

export function assertBilateralSync(env: Env, entityA: string, entityB: string, tokenId: number, label: string): void {
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

  const deltaFromA = accountFromA.deltas?.get(tokenId);
  const deltaFromB = accountFromB.deltas?.get(tokenId);
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
