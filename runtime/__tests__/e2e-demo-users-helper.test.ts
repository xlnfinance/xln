import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

describe('e2e demo user helper', () => {
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

  test('waits for hub gossip profile hydration through a connected p2p client', () => {
    const helper = readFileSync(join(repoRoot, 'tests/utils/e2e-connect.ts'), 'utf8');
    const waitForProfileStart = helper.indexOf('async function waitForHubRuntimeProfile');
    const waitForProfileEnd = helper.indexOf('async function waitForHubRuntimeTransportReady');
    expect(waitForProfileStart).toBeGreaterThanOrEqual(0);
    expect(waitForProfileEnd).toBeGreaterThan(waitForProfileStart);

    const body = helper.slice(waitForProfileStart, waitForProfileEnd);
    expect(body).toContain('lastHubProfileState');
    expect(body).toContain('connectedBefore');
    expect(body).toContain('p2p.connect()');
    expect(body).toContain('p2p.reconnect()');
    expect(body).toContain('const ensureResult = await p2p.ensureProfiles?.([target])');
    expect(body.indexOf('p2p.connect()')).toBeLessThan(body.indexOf('p2p.ensureProfiles'));
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
