import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

describe('e2e demo user helper', () => {
  test('cross-j browser helpers never mutate a detached Runtime view', () => {
    const paths = [
      'tests/e2e-cross-j-swap-helpers-a.ts',
      'tests/e2e-cross-j-swap-helpers-b.ts',
      'tests/e2e-cross-j-swap.spec.ts',
    ];
    const source = paths.map(path => readFileSync(join(repoRoot, path), 'utf8')).join('\n');
    const forbidden = [
      'isolatedEnv.infrastructure',
      'enqueueRuntimeInput(env',
      'applyJEventsToEnv(',
      'registerSignerKey(env',
      'registerRuntimeFrameCommitCallback(env',
    ];

    for (const pattern of forbidden) expect(source).not.toContain(pattern);
    expect(source).toContain('const env = debug?.env()');
    expect(source).toContain('CURRENT_WALLET_RUNTIME_MISSING');
    expect(source).toContain('api.waitForRuntimeProcessingIdle(env, 1_000)');
  });

  test('AHB browser flow reads transport status through the narrow connectivity boundary', () => {
    const paths = ['tests/e2e/payments/e2e-ahb-payment.spec.ts', 'tests/e2e-custody.spec.ts'];
    const source = paths.map(path => readFileSync(join(repoRoot, path), 'utf8')).join('\n');
    const forbidden = ['infrastructure?.p2p', 'infrastructure.p2p', 'p2p.clients', 'p2p.relayUrls'];

    for (const pattern of forbidden) expect(source).not.toContain(pattern);
    expect(source).toContain('__xln?.runtimeConnectivity');
  });

  test('browser E2E reads no live infrastructure through detached Runtime views', () => {
    const exceptionPaths = new Set([
      'tests/e2e/runtime/e2e-runtime-ingress-debug.spec.ts',
      'tests/e2e/recovery/e2e-storage-writer-lock.spec.ts',
    ]);
    const paths = [
      ...readdirSync(join(repoRoot, 'tests'))
        .filter(name => name.endsWith('.spec.ts'))
        .map(name => `tests/${name}`),
      ...readdirSync(join(repoRoot, 'tests/utils'))
        .filter(name => name.endsWith('.ts'))
        .map(name => `tests/utils/${name}`),
    ].filter(path => !exceptionPaths.has(path));

    for (const path of paths) {
      const source = readFileSync(join(repoRoot, path), 'utf8');
      if (path === 'tests/utils/e2e-connect.ts') {
        expect(source).toContain('__xln?.env()');
        expect(source).not.toContain('isolatedEnv');
        continue;
      }
      expect(source, `${path} must use a narrow live status or command surface`).not.toContain('.infrastructure');
    }
  });

  test('runtime persistence E2E configures the live Runtime through a narrow control', () => {
    const source = readFileSync(join(repoRoot, 'tests/e2e/runtime/e2e-runtime-persistence.spec.ts'), 'utf8');
    const persistenceStore = readFileSync(join(repoRoot, 'tests/utils/runtime/e2e-persistence-proof.ts'), 'utf8');
    const commandStore = readFileSync(join(repoRoot, 'frontend/src/lib/stores/xlnStore.ts'), 'utf8');
    expect(source).not.toContain('env.runtimeConfig');
    expect(source).toContain('setCheckpointPeriod(page, 5)');
    expect(persistenceStore).toContain('await xln.waitForRuntimeWorkDrained(env, 5_000)');
    expect(commandStore).toContain('xln.waitForRuntimeWorkDrained(runtimeEnv, timeoutMs)');
    expect(persistenceStore).toContain('Number.isSafeInteger(period) || period < 1');
    expect(persistenceStore).toContain('snapshotPeriodFrames: period');
    expect(persistenceStore).not.toContain('snapshotIntervalFrames: frames');
    expect(persistenceStore).not.toContain('readPersistedAccountFrameHistory');
    expect(persistenceStore).not.toContain('readAccountRebalanceFees');
  });

  test('Account swap history starts only from the explicit Closed-tab action', () => {
    const panel = readFileSync(join(repoRoot, 'frontend/src/lib/components/Entity/swap/SwapPanel.svelte'), 'utf8');
    const list = readFileSync(join(repoRoot, 'frontend/src/lib/components/Entity/swap/SwapOrderList.svelte'), 'utf8');
    expect(panel).not.toContain('`${runtimeHeight}:${sourceEntityIdValue}:${activeOrderAccountId}`');
    expect(panel).toContain('onSelectClosedHistory={requestClosedSwapHistory}');
    expect(list).toContain('void onSelectClosedHistory();');
    expect(list).toContain('onLoadOlderClosedHistory');
  });

  test('assists profile onboarding before waiting for runtime readiness', () => {
    const helper = readFileSync(join(repoRoot, 'tests/utils/e2e-demo-users.ts'), 'utf8');
    const waitForReadyStart = helper.indexOf('async function waitForReadyAfterCreate');
    const waitForReadyEnd = helper.indexOf('async function completeProfileOnboardingIfVisible');
    expect(waitForReadyStart).toBeGreaterThanOrEqual(0);
    expect(waitForReadyEnd).toBeGreaterThan(waitForReadyStart);

    const waitForReadyBody = helper.slice(waitForReadyStart, waitForReadyEnd);
    expect(waitForReadyBody).toContain('onboardingLabel?: string');
    expect(waitForReadyBody).toContain("options.onboardingLabel || 'XLN runtime'");
    expect(waitForReadyBody.indexOf('await completeProfileOnboardingIfVisible(')).toBeLessThan(
      waitForReadyBody.lastIndexOf('return await waitForNextRuntimeReady(page, previousRuntimeId);'),
    );

    const createRuntime = helper.slice(helper.indexOf('export async function createRuntime'));
    expect(createRuntime).toContain('onboardingLabel: label');
  });

  test('navigates through the canonical app redirect to the React wallet', () => {
    const helper = readFileSync(join(repoRoot, 'tests/utils/e2e-demo-users.ts'), 'utf8');
    const gotoStart = helper.indexOf('export async function gotoApp');
    const gotoEnd = helper.indexOf('export async function createRuntime');
    expect(gotoStart).toBeGreaterThanOrEqual(0);
    expect(gotoEnd).toBeGreaterThan(gotoStart);

    const body = helper.slice(gotoStart, gotoEnd);
    expect(body).toContain("current.origin !== origin || !current.pathname.startsWith('/ui/')");
    expect(body).toContain('await page.goto(`${origin}/app`');
    expect(body).toContain('await expect(page).toHaveURL');
    expect(body).not.toContain('installPageBindings');
  });

  test('never bypasses visible profile onboarding through browser storage', () => {
    const helper = readFileSync(join(repoRoot, 'tests/utils/e2e-demo-users.ts'), 'utf8');
    const dismissStart = helper.indexOf('async function dismissOnboardingIfVisible');
    const dismissEnd = helper.indexOf('async function waitForReadyAfterCreate');
    const completeStart = helper.indexOf('async function completeProfileOnboardingIfVisible');
    const completeEnd = helper.indexOf('async function ensureRuntimeOnline');
    expect(dismissStart).toBeGreaterThanOrEqual(0);
    expect(dismissEnd).toBeGreaterThan(dismissStart);
    expect(completeStart).toBeGreaterThanOrEqual(0);
    expect(completeEnd).toBeGreaterThan(completeStart);

    const dismissBody = helper.slice(dismissStart, dismissEnd);
    expect(dismissBody).not.toContain('localStorage.setItem');
    expect(dismissBody).toContain('PROFILE_ONBOARDING_UNSUPPORTED_VISIBLE');

    const completeBody = helper.slice(completeStart, completeEnd);
    expect(completeBody).not.toContain('localStorage.setItem');
    expect(completeBody).toContain('PROFILE_ONBOARDING_START_MISSING');
    expect(completeBody).toContain('PROFILE_ONBOARDING_START_DISABLED');
    expect(completeBody).toContain('PROFILE_ONBOARDING_SUBMIT_FAILED');
  });

  test('waits for hub gossip profile hydration through the narrow connectivity boundary', () => {
    const helper = readFileSync(join(repoRoot, 'tests/utils/e2e-connect.ts'), 'utf8');
    const waitForProfileStart = helper.indexOf('async function waitForHubRuntimeProfile');
    const waitForProfileEnd = helper.indexOf('async function waitForHubRuntimeTransportReady');
    expect(waitForProfileStart).toBeGreaterThanOrEqual(0);
    expect(waitForProfileEnd).toBeGreaterThan(waitForProfileStart);

    const body = helper.slice(waitForProfileStart, waitForProfileEnd);
    expect(body).toContain('env.gossip.getProfile(hubId.toLowerCase())?.runtimeId');
    expect(body).toContain('CURRENT_WALLET_RUNTIME_MISSING');
    expect(helper).toContain('await waitForHubRuntimeProfile(page, hubId, timeoutMs)');
    expect(helper).toContain('await xln.ensureGossipProfiles(env, targets)');
    expect(helper).toContain('env.gossip.getProfiles()');
    expect(body).not.toContain('isolatedEnv.infrastructure');
  });

  test('production Account opening is verified through public wallet controls', () => {
    const source = readFileSync(join(repoRoot, 'ui/tests/e2e-production-wallet.spec.ts'), 'utf8');
    expect(source).toContain("from './wallet-ui'");
    expect(source).toContain("'__xln' in window");
    expect(source).toContain("getByTestId('open-account-submit')");
    expect(source).toContain("getByTestId('account-frame-row')");
    expect(source).not.toContain('__xln.env');
  });
});
