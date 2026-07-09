import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeInput } from '@xln/runtime/xln-api';
import {
  clearRuntimeCommandReceipts,
  recordRuntimeIngressReceipt,
  runtimeCommandLatestReceipt,
  runtimeCommandReceipts,
  submitRuntimeCommand,
} from '../../frontend/src/lib/stores/runtimeCommandBus';

const frontendSourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return frontendSourceFiles(path);
    return /\.(svelte|ts)$/.test(path) ? [path] : [];
  });

const readStore = <T>(store: { subscribe: (run: (value: T) => void) => () => void }): T => {
  let value: T | undefined;
  const unsubscribe = store.subscribe((next) => {
    value = next;
  });
  unsubscribe();
  return value as T;
};

test('runtime command bus records pending accepted observed committed error receipts deterministically', () => {
  const source = readFileSync('frontend/src/lib/stores/runtimeCommandBus.ts', 'utf8');

  expect(source).toContain("export type RuntimeCommandStatus = 'pending' | 'accepted' | 'observed' | 'committed' | 'error'");
  expect(source).toContain('receiptId: `runtime-command-${++receiptSequence}`');
	  expect(source).toContain('acceptedAtHeight');
  expect(source).toContain('committedAtHeight');
	  expect(source).toContain('upstreamReceiptId');
	  expect(source).toContain('statusUrl');
	  expect(source).not.toContain('commitAcceptedRuntimeCommands');
  expect(source).toContain('recordRuntimeIngressReceipt');
  expect(source).toContain('classifyRuntimeFailure');
  expect(source).toContain('failureKind: RuntimeFailureKind | null');
  expect(source).toContain("status: receipt.mode === 'remote' ? 'observed' : 'committed'");
  expect(source).toContain("upstreamStatus === 'observed' ? 'observed'");
  expect(source).toContain("registerDebugSurface('commands'");
  expect(source).not.toContain('__xlnRuntimeCommands');
  expect(source).not.toContain('Date.now');
  expect(source).not.toContain('Math.random');
});

test('runtime command bus transitions receipts from pending to accepted committed and error', async () => {
  clearRuntimeCommandReceipts();
  const input: RuntimeInput = {
    runtimeTxs: [],
    entityInputs: [],
    jInputs: [],
  };

  const committed = await submitRuntimeCommand({
    input,
    runtimeId: 'runtime-a',
    mode: 'embedded',
    initialHeight: 4,
  }, async (progress) => {
    expect(readStore(runtimeCommandLatestReceipt)?.status).toBe('pending');
    progress.accepted(5);
    expect(readStore(runtimeCommandLatestReceipt)?.status).toBe('accepted');
    progress.committed(6);
    expect(readStore(runtimeCommandLatestReceipt)?.status).toBe('committed');
    return 'ok';
  });

  expect(committed.result).toBe('ok');
  expect(committed.receipt.receiptId).toMatch(/^runtime-command-/);
  expect(committed.receipt.status).toBe('committed');
  expect(committed.receipt.runtimeId).toBe('runtime-a');
  expect(committed.receipt.mode).toBe('embedded');
  expect(committed.receipt.acceptedAtHeight).toBe(5);
  expect(committed.receipt.committedAtHeight).toBe(6);
  expect(committed.receipt.upstreamReceiptId).toBeNull();
  expect(committed.receipt.statusUrl).toBeNull();
  expect(readStore(runtimeCommandReceipts)).toHaveLength(1);

  const remoteAccepted = await submitRuntimeCommand({
    input,
    runtimeId: 'runtime-remote',
    mode: 'remote',
    initialHeight: 20,
  }, async (progress) => {
    progress.accepted(21, { receiptId: 'upstream-1', statusUrl: '/api/control/runtime-input/upstream-1/status' });
    progress.committed(22);
    return 'remote-ok';
  });
  expect(remoteAccepted.receipt.status).toBe('accepted');
  expect(remoteAccepted.receipt.committedAtHeight).toBeNull();
  expect(readStore(runtimeCommandLatestReceipt)?.runtimeId).toBe('runtime-remote');
  expect(readStore(runtimeCommandLatestReceipt)?.status).toBe('accepted');

  const remoteObserved = await submitRuntimeCommand({
    input,
    runtimeId: 'runtime-remote-observed',
    mode: 'remote',
    initialHeight: 30,
  }, async (progress) => {
    progress.accepted(31, { receiptId: 'upstream-observed', statusUrl: '/api/control/runtime-input/upstream-observed/status' });
    progress.observed(32);
    return 'remote-observed';
  });
  expect(remoteObserved.receipt.status).toBe('observed');
  expect(remoteObserved.receipt.acceptedAtHeight).toBe(31);
  expect(remoteObserved.receipt.committedAtHeight).toBe(32);

  const acceptedOnly = await submitRuntimeCommand({
    input,
    runtimeId: 'runtime-b',
    mode: 'embedded',
    initialHeight: 10,
  }, async (progress) => {
    progress.accepted(10);
    return 'accepted';
  });
  expect(acceptedOnly.receipt.status).toBe('accepted');
  expect(readStore(runtimeCommandLatestReceipt)?.runtimeId).toBe('runtime-b');
  expect(readStore(runtimeCommandLatestReceipt)?.status).toBe('accepted');
  expect(readStore(runtimeCommandLatestReceipt)?.committedAtHeight).toBeNull();

  await expect(submitRuntimeCommand({
    input,
    runtimeId: 'runtime-c',
    mode: 'remote',
    initialHeight: 1,
  }, async (progress) => {
    progress.accepted(2);
    throw new Error('boom');
  })).rejects.toThrow('boom');
  const latest = readStore(runtimeCommandLatestReceipt);
  expect(latest?.runtimeId).toBe('runtime-c');
  expect(latest?.status).toBe('error');
  expect(latest?.acceptedAtHeight).toBe(2);
  expect(latest?.error).toBe('boom');
  expect(latest?.failureKind).toBe('fatal');
  expect(latest?.failureRetryable).toBe(false);

  await expect(submitRuntimeCommand({
    input,
    runtimeId: 'runtime-d',
    mode: 'remote',
    initialHeight: 1,
  }, async () => {
    throw new Error('fetch failed: ECONNREFUSED');
  })).rejects.toThrow('fetch failed');
  const retryable = readStore(runtimeCommandLatestReceipt);
  expect(retryable?.failureKind).toBe('defer');
  expect(retryable?.failureRetryable).toBe(true);
});

test('runtime command bus records server ingress receipts without fake RuntimeInput', () => {
  clearRuntimeCommandReceipts();

  const receipt = recordRuntimeIngressReceipt({
    runtimeId: 'server-runtime',
    mode: 'remote',
    receipt: {
      id: 'credit-1',
      status: 'pending',
      counts: { runtimeTxs: 0, entityInputs: 1, jInputs: 0 },
      enqueuedHeight: 12,
    },
    statusUrl: '/api/control/runtime-input/credit-1/status',
  });

  expect(receipt.status).toBe('accepted');
  expect(receipt.runtimeId).toBe('server-runtime');
  expect(receipt.mode).toBe('remote');
  expect(receipt.upstreamReceiptId).toBe('credit-1');
  expect(receipt.acceptedAtHeight).toBe(12);
  expect(receipt.statusUrl).toBe('/api/control/runtime-input/credit-1/status');
  expect(receipt.inputSummary).toEqual({
    runtimeTxs: 0,
    entityInputs: 1,
    jInputs: 0,
    entityTxs: 0,
  });
  expect(readStore(runtimeCommandLatestReceipt)).toEqual(receipt);
  expect(receipt.failureKind).toBeNull();
  expect(receipt.failureRetryable).toBe(false);

  const observed = recordRuntimeIngressReceipt({
    runtimeId: 'server-runtime',
    mode: 'remote',
    receipt: {
      id: 'credit-1',
      status: 'observed',
      counts: { runtimeTxs: 0, entityInputs: 1, jInputs: 0 },
      enqueuedHeight: 12,
      observedHeight: 13,
    },
    statusUrl: '/api/control/runtime-input/credit-1/status',
  });
  expect(observed.status).toBe('observed');
  expect(observed.acceptedAtHeight).toBe(12);
  expect(observed.committedAtHeight).toBe(13);

  const expired = recordRuntimeIngressReceipt({
    runtimeId: 'server-runtime',
    mode: 'remote',
    receipt: {
      id: 'credit-expired',
      status: 'expired',
      note: 'Runtime ingress receipt expired',
      enqueuedHeight: 14,
    },
    statusUrl: '/api/control/runtime-input/credit-expired/status',
  });
  expect(expired.status).toBe('error');
  expect(expired.error).toBe('Runtime ingress receipt expired');
  expect(expired.failureKind).toBe('drop');
  expect(expired.failureRetryable).toBe(false);
});

test('xlnStore routes RuntimeInput mutations through RuntimeCommandBus', () => {
  const source = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const routeIndex = source.indexOf('const routeRuntimeInput = async');
  expect(routeIndex).toBeGreaterThan(0);
  const routeSource = source.slice(routeIndex, source.indexOf('// Enqueue entity inputs', routeIndex));

  expect(routeSource).toContain('submitRuntimeCommand');
	  expect(routeSource).toContain('progress.accepted');
	  expect(routeSource).toContain('receiptId: accepted.receipt?.id ?? null');
	  expect(routeSource).toContain('statusUrl: accepted.statusUrl ?? null');
	  expect(routeSource).toContain('waitForRemoteRuntimeReceiptObserved');
	  expect(routeSource).toContain('progress.observed');
	  expect(routeSource).toContain('progress.committed');
	  expect(routeSource).toContain('const usesRemoteAdapter = Boolean');
	  expect(routeSource).toContain('REMOTE_RUNTIME_ENV_MISMATCH');
	  expect(routeSource).toContain('!targetRuntimeId || !handleRuntimeId || targetRuntimeId === handleRuntimeId');
	  expect(routeSource).toContain('mode: usesRemoteAdapter ? \'remote\' : \'embedded\'');
  expect(routeSource).toContain('if (usesRemoteAdapter)');
  expect(routeSource).toContain('embeddedAdapterTargetsRuntimeEnv(runtimeEnv)');
  expect(routeSource).toContain('xln.enqueueRuntimeInput(runtimeEnv, input)');
	  expect(source).not.toContain('commitAcceptedRuntimeCommands');
		  expect(source).not.toContain("registerDebugSurface('submit'");
		  expect(source).not.toContain('__xlnRuntimeSubmit');
	  expect(source).toContain("from './runtimeStore';");
	  expect(source).toContain('activeEnv');
	  expect(source).toContain('activeRuntimeId');
	  expect(source).toContain('runtimes');
	  expect(source).toContain('runtimeOperations');
	  expect(source).toContain('export async function submitActiveRuntimeInput');
	  expect(source).toContain('export async function submitActiveEntityInputs');
	  expect(source).toContain('export async function submitRuntimeInput');
	  expect(source).toContain('export async function submitEntityInputs');
	});

test('public mutation exports no longer accept caller-owned Env', () => {
  const source = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  expect(source).not.toContain('assertSubmittedEnvMatchesActiveRuntime');

  const submitRuntimeIndex = source.indexOf('export async function submitRuntimeInput');
  const submitEntityIndex = source.indexOf('export async function submitEntityInputs');
  const utilityFunctionsIndex = source.indexOf('// === FRONTEND UTILITY FUNCTIONS ===');
  expect(submitRuntimeIndex).toBeGreaterThan(0);
  expect(submitEntityIndex).toBeGreaterThan(submitRuntimeIndex);
  expect(utilityFunctionsIndex).toBeGreaterThan(submitEntityIndex);

  const submitRuntimeSource = source.slice(submitRuntimeIndex, submitEntityIndex);
  expect(submitRuntimeSource).toContain('export async function submitRuntimeInput(input: RuntimeInput)');
  expect(submitRuntimeSource).toContain('return submitActiveRuntimeInput(input);');
  expect(submitRuntimeSource).not.toContain('env: Env');
  expect(submitRuntimeSource).not.toContain('assertSubmittedEnvMatchesActiveRuntime');
  expect(submitRuntimeSource).not.toContain('routeRuntimeInput(');

  const submitEntitySource = source.slice(submitEntityIndex, utilityFunctionsIndex);
  expect(submitEntitySource).toContain('export async function submitEntityInputs(inputs: RoutedEntityInput[] = [])');
  expect(submitEntitySource).toContain('return submitActiveEntityInputs(inputs);');
  expect(submitEntitySource).not.toContain('env: Env');
  expect(submitEntitySource).not.toContain('submitRuntimeInput(env');
  expect(submitEntitySource).not.toContain('assertSubmittedEnvMatchesActiveRuntime');
  expect(submitEntitySource).not.toContain('routeRuntimeInput(');
});

test('server-side credit requests publish upstream runtime ingress receipts', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/CreditForm.svelte', 'utf8');

  expect(source).toContain('recordRuntimeIngressReceipt');
  expect(source).toContain('runtimeControllerHandle');
  expect(source).toContain("fetch(`${apiBase}/api/credit/request`");
  expect(source).toContain('receipt: result.receipt');
  expect(source).toContain('statusUrl: result.statusUrl ?? null');
});

test('credit and collateral configure forms submit RuntimeInput through shared command path', () => {
  const creditSource = readFileSync('frontend/src/lib/components/Entity/CreditForm.svelte', 'utf8');
  const collateralSource = readFileSync('frontend/src/lib/components/Entity/CollateralForm.svelte', 'utf8');
  const configureSource = readFileSync('frontend/src/lib/components/Entity/AccountConfigurePanel.svelte', 'utf8');
  const accountWorkspaceSource = readFileSync('frontend/src/lib/components/Entity/AccountWorkspaceView.svelte', 'utf8');
  const resolverSource = readFileSync('runtime/radapter/resolve.ts', 'utf8');

  for (const source of [creditSource, collateralSource]) {
    expect(source).toContain('export let submitRuntimeInput');
    expect(source).toContain('await submitRuntimeInput({ runtimeTxs: [], entityInputs: [');
    expect(source).toContain("handle.mode === 'remote' && handle.authLevel === 'admin'");
    expect(source).not.toContain('submitEntityInputs([');
    expect(source).not.toContain("from '../../stores/xlnStore';\n  import { submitEntityInputs");
  }

  expect(configureSource).toContain('remoteAdminReady');
  expect(configureSource).toContain('commandReady = activeIsLive && Boolean(liveRuntimeEnv || remoteAdminReady)');
  expect(configureSource).toContain('{submitRuntimeInput}');
  expect(accountWorkspaceSource).toContain('<AccountConfigurePanel');
  expect(accountWorkspaceSource).toContain('{submitRuntimeInput}');
  expect(collateralSource).toContain('resolveProjectedCounterpartyPolicy');
  expect(collateralSource).toContain('counterpartyRebalanceFeePolicy');
  expect(resolverSource).toContain('compact.counterpartyRebalanceFeePolicy = doc.counterpartyRebalanceFeePolicy');
});

test('payment panel submits RuntimeInput through shared command path', () => {
  const paymentSource = readFileSync('frontend/src/lib/components/Entity/PaymentPanel.svelte', 'utf8');
  const accountWorkspaceSource = readFileSync('frontend/src/lib/components/Entity/AccountWorkspaceView.svelte', 'utf8');

  expect(paymentSource).toContain('export let submitRuntimeInput');
  expect(paymentSource).toContain('await submitRuntimeInput({ runtimeTxs: [], entityInputs: [paymentInput], jInputs: [] })');
  expect(paymentSource).not.toContain('submitEntityInputs');
  expect(accountWorkspaceSource).toContain('{submitRuntimeInput}');
});

test('server-side lending requests publish upstream runtime ingress receipts', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/LendingPanel.svelte', 'utf8');

  expect(source).toContain('recordRuntimeIngressReceipt');
  expect(source).toContain('runtimeControllerHandle');
  expect(source).toContain("postLending('/api/lending/offer'");
  expect(source).toContain("postLending('/api/lending/borrow'");
  expect(source).toContain("postLending('/api/lending/repay'");
  expect(source).toContain('receipt: result.receipt');
  expect(source).toContain('statusUrl: result.statusUrl ?? null');
});

test('server-side faucet requests publish upstream runtime ingress receipts when provided', () => {
  const panelSource = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');
  const faucetSource = readFileSync('frontend/src/lib/components/Entity/account-faucet.ts', 'utf8');

  expect(faucetSource).toContain('receipt?: {');
  expect(panelSource).toContain('recordRuntimeIngressReceipt');
  expect(panelSource).toContain('function recordServerIngressReceipt');
  expect(panelSource).toContain('recordServerIngressReceipt(result);');
  expect(panelSource).toContain('statusUrl: result.statusUrl ?? null');
});

test('ui mutation surfaces do not use legacy enqueue entrypoints', () => {
  const files = frontendSourceFiles('frontend/src/lib')
    .filter((file) => !file.startsWith('frontend/src/lib/stores/'));

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    expect(source, file).not.toMatch(/\bXLN\.enqueueRuntimeInput/);
    expect(source, file).not.toMatch(/\(XLN as any\)\.enqueueRuntimeInput/);
    expect(source, file).not.toMatch(/\bxln\.enqueueRuntimeInput/);
    expect(source, file).not.toMatch(/\benqueueEntityInputs\b/);
    expect(source, file).not.toMatch(/\benqueueAndProcess\b/);
    expect(source, file).not.toMatch(/\bsubmitRuntimeInput\(\s*(env|runtimeEnv|currentEnv|actionEnv|\$runtimeFrameEnv|crossCommandEnv),/);
    expect(source, file).not.toMatch(/\bsubmitEntityInputs\(\s*(env|runtimeEnv|currentEnv|actionEnv|\$runtimeFrameEnv|crossCommandEnv),/);
  }
});

test('entity workspace renders latest runtime command receipt status', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/EntityWorkspace.svelte', 'utf8');

  expect(source).toContain('runtimeCommandLatestReceipt');
  expect(source).toContain('data-testid="runtime-command-receipt"');
  expect(source).toContain('failureKind');
	  expect(source).toContain('committedAtHeight');
	  expect(source).toContain('acceptedAtHeight');
	  expect(source).toContain('upstreamReceiptId');
	});

test('entity panel j-event snapshots submit RuntimeInput instead of mutating Env directly', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');
  const applyIndex = source.indexOf('async function applyCanonicalJEventsToActiveEnv');
  expect(applyIndex).toBeGreaterThan(0);
  const applySource = source.slice(applyIndex, source.indexOf('async function requestExternalWalletSnapshot', applyIndex));

  expect(applySource).toContain('buildJEventsRuntimeInput');
  expect(applySource).toContain('getRuntimeEnv(actionRuntimeEnv)');
  expect(applySource).toContain('submitRuntimeCommandInput(runtimeInput)');
  expect(applySource).not.toContain('submitRuntimeCommandInput(env, runtimeInput)');
  expect(applySource).not.toContain('applyJEventsToEnv');
  expect(applySource).not.toContain('xln.process');
  expect(applySource).not.toContain('setXlnEnvironment');
});

test('entity panel pure RuntimeInput mutations do not require embedded Env on remote', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');

  expect(source).not.toContain('requireRuntimeEnv(activeEnv');
  expect(source).not.toContain("requireRuntimeEnv(actionRuntimeEnv, 'settings-profile-update')");
  expect(source).not.toContain("requireRuntimeEnv(actionRuntimeEnv, 'reserve-to-external')");
  expect(source).not.toContain("requireRuntimeEnv(actionRuntimeEnv, 'reserve-to-reserve')");
  expect(source).not.toContain("requireRuntimeEnv(actionRuntimeEnv, 'quick-settle-approve')");
  expect(source).not.toContain("requireRuntimeEnv(actionRuntimeEnv, 'asset-c2r-auto-execute')");
  expect(source).not.toContain("requireRuntimeEnv(actionRuntimeEnv, 'collateral-to-reserve')");
  expect(source).not.toContain("requireRuntimeEnv(actionRuntimeEnv, 'move-reserve-to-reserve-draft')");
  expect(source).not.toContain("requireRuntimeEnv(actionRuntimeEnv, 'move-reserve-to-account-draft')");
  expect(source).not.toContain("requireRuntimeEnv(actionRuntimeEnv, 'reserve-to-collateral')");
  expect(source).not.toContain("requireRuntimeEnv(actionRuntimeEnv, 'dispute-start')");
  expect(source).not.toContain("requireRuntimeEnv(actionRuntimeEnv, 'add-token-to-account')");
  expect(source).not.toContain("throw new Error('Environment not ready')");
  expect(source).toContain("requireRuntimeEnv(actionRuntimeEnv, 'settings-import-jmachine')");
  expect(source).toContain("requireRuntimeEnv(actionRuntimeEnv, 'send-external-asset')");
  expect(source).not.toContain("requireRuntimeEnv(actionRuntimeEnv, 'move-reserve-to-external-draft')");
  expect(source).not.toContain("requireRuntimeEnv(actionRuntimeEnv, 'move-external-to-reserve-draft')");
  expect(source).not.toContain("requireRuntimeEnv(actionRuntimeEnv, 'debt-enforcement')");
  expect(source).toContain("resolveEntitySigner(entityId, 'reserve-to-external')");
  expect(source).toContain("resolveEntitySigner(entityId, 'move-reserve-to-external-draft')");
  expect(source).toContain("resolveEntitySigner(entityId, 'move-external-to-reserve-draft')");
  expect(source).toContain("resolveEntitySigner(entityId, 'debt-enforcement')");
  expect(source).toContain("resolveEntitySigner(entityId, 'reserve-to-collateral')");
  expect(source).toContain("resolveEntitySigner(entityId, 'add-token-to-account')");
  expect(source).toContain("getRuntimeId(actionRuntimeEnv)");
});

test('entity panel debt enforcement submits RuntimeInput instead of calling JAdapter directly', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');
  const enforceIndex = source.indexOf('async function enforceOutstandingDebt');
  expect(enforceIndex).toBeGreaterThan(0);
  const enforceSource = source.slice(enforceIndex, source.indexOf('async function addTokenToAccount', enforceIndex));

  expect(existsSync('frontend/src/lib/components/Entity/debt-enforcement-command.ts')).toBe(false);
  expect(source).toContain("import { buildDebtEnforcementRuntimeInputFromProjection } from '@xln/runtime/debt-enforcement-command';");
  expect(enforceSource).toContain('buildDebtEnforcementRuntimeInputFromProjection');
  expect(enforceSource).toContain('jurisdictionName');
  expect(enforceSource).toContain("timestamp: requirePanelRuntimeTimestamp('debt-enforcement')");
  expect(enforceSource).not.toContain('Date.now()');
  expect(enforceSource).toContain('submitRuntimeCommandInput(input)');
  expect(enforceSource).not.toContain('requireRuntimeEnv(actionRuntimeEnv');
  expect(enforceSource).not.toContain('getXLN()');
  expect(enforceSource).not.toContain('xln.buildDebtEnforcementRuntimeInput');
  expect(enforceSource).not.toContain('submitRuntimeCommandInput(env, input)');
  expect(enforceSource).not.toContain('submitDebtEnforcement');
});
