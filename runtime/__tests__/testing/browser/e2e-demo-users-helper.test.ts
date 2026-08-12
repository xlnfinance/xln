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
      'waitForRuntimeProcessingIdle(env',
    ];

    for (const pattern of forbidden) expect(source).not.toContain(pattern);
    expect(source).toContain('__xln?.jurisdictionConnectivity');
    expect(source).toContain('__xln?.runtimeIngress?.waitForProcessingIdle');
  });

  test('AHB browser flow reads transport status through the narrow connectivity boundary', () => {
    const paths = [
      'tests/e2e-ahb-payment.spec.ts',
      'tests/e2e-custody.spec.ts',
    ];
    const source = paths.map(path => readFileSync(join(repoRoot, path), 'utf8')).join('\n');
    const forbidden = [
      'infrastructure?.p2p',
      'infrastructure.p2p',
      'p2p.clients',
      'p2p.relayUrls',
    ];

    for (const pattern of forbidden) expect(source).not.toContain(pattern);
    expect(source).toContain('__xln?.runtimeConnectivity');
  });

  test('browser E2E reads no live infrastructure through detached Runtime views', () => {
    const exceptionPaths = new Set([
      'tests/e2e-runtime-ingress-debug.spec.ts',
      'tests/e2e-storage-writer-lock.spec.ts',
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
      expect(source, `${path} must use a narrow live status or command surface`).not.toContain('.infrastructure');
    }
  });

  test('runtime persistence E2E configures the live Runtime through a narrow control', () => {
    const source = readFileSync(join(repoRoot, 'tests/e2e-runtime-persistence.spec.ts'), 'utf8');
    const persistenceStore = readFileSync(join(repoRoot, 'frontend/src/lib/stores/bootstrap/embeddedRuntimeStore.ts'), 'utf8');
    const commandStore = readFileSync(join(repoRoot, 'frontend/src/lib/stores/xlnStore.ts'), 'utf8');
    expect(source).not.toContain('env.runtimeConfig');
    expect(source).toContain('__xln?.runtimePersistence');
    expect(source).toContain('setSnapshotPeriodFrames(frames)');
    expect(source).toContain('await ingress.waitForDrained(5_000)');
    expect(commandStore).toContain('xln.waitForRuntimeWorkDrained(runtimeEnv, timeoutMs)');
    expect(persistenceStore).toContain('Number.isSafeInteger(frames)');
    expect(persistenceStore).not.toContain('snapshotIntervalFrames: frames');
    expect(persistenceStore).toContain('xln.readPersistedAccountFrameHistory(');
    expect(persistenceStore).toContain("tx.type !== 'request_collateral'");
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
    expect(body).toContain('lastHubProfileState');
    expect(body).toContain('connectedBefore');
    expect(body).toContain('connectivity.connect()');
    expect(body).toContain('connectivity.reconnect()');
    expect(body).toContain('const ensureResult = await connectivity.ensureProfiles?.([target])');
    expect(body.indexOf('connectivity.connect()')).toBeLessThan(body.indexOf('connectivity.ensureProfiles'));
    expect(body).not.toContain('isolatedEnv.infrastructure');
  });

  test('uses public readiness checks for prod UI-only hub connect', () => {
    const helper = readFileSync(join(repoRoot, 'tests/utils/e2e-connect.ts'), 'utf8');
    const connectStart = helper.indexOf('async function connectHubThroughUi');
    const connectEnd = helper.indexOf('async function waitForRenderedCommittedAccountCard');
    expect(connectStart).toBeGreaterThanOrEqual(0);
    expect(connectEnd).toBeGreaterThan(connectStart);

    const connectBody = helper.slice(connectStart, connectEnd);
    expect(connectBody.indexOf('if (await hasRenderedCommittedAccountCard(page, hubId)) return;')).toBeLessThan(
      connectBody.indexOf('if (await hasExportedRuntimeP2P(page))'),
    );
    expect(connectBody).toContain('if (await hasExportedRuntimeP2P(page))');
    expect(connectBody).toContain('waitForHubRuntimeTransportReady(page, hubId)');
    expect(connectBody).toContain('waitForPublicHubRuntimeProfile(page, hubId)');
    expect(connectBody.indexOf('waitForPublicHubRuntimeProfile(page, hubId)')).toBeLessThan(
      connectBody.indexOf('hub-connect-button'),
    );

    const full = helper;
    expect(full).toContain("new URL('/api/gossip/profile', origin)");
    expect(full).toContain('async function hasExportedRuntimeP2P');
  });
});
