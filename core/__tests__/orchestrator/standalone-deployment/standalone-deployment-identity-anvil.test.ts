import { expect, test } from 'bun:test';
import { startStandaloneNode } from './standalone-deployment-support';
import { launchDeployment } from './standalone-deployment-process-support';
import { policyConfig } from './standalone-deployment-policy-config';
import { awaitVerification } from './standalone-deployment-transactions-support';
import { until } from '../stack-manager-recovery/stack-manager-resume-support';

test('resume rejects a changed resolved native fee policy even with unchanged config source', async () => {
  const fixture = await startStandaloneNode(0);
  const config = await policyConfig();
  let session = launchDeployment(fixture, 'policy-original', { config: config.path });
  try {
    await awaitVerification(session);
    await session.stop();
    const before = fixture.submissions();
    session = launchDeployment(fixture, 'policy-resumed', {
      mode: 'resume',
      config: config.path,
      environment: { XLN_PROBE_BUMP_MS: '2000' },
    });
    await until(
      async () => session.outcome() !== undefined || (await session.log()).includes('XLN_DEPLOY_PHASE:verifying'),
      'policy-changed',
    );
    expect(session.outcome()).not.toBeUndefined();
    expect(await session.exited).not.toBe(0);
    expect(await session.log()).toContain('STACK_MANAGER_EXECUTION_IDENTITY_MISMATCH');
    expect(fixture.submissions()).toBe(before);
  } finally {
    await session.stop();
    await config.close();
    await fixture.close();
  }
}, 60_000);
