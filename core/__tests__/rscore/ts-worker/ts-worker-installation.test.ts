import { afterEach, describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime';
import { installTsAccountWorkerAuthority } from '../../../rscore/ts-worker/provider';

const priorWorkerCount = process.env['XLN_TS_ACCOUNT_WORKERS'];
const priorHubName = process.env['XLN_HUB_NAME'];

afterEach(() => {
  if (priorWorkerCount === undefined) delete process.env['XLN_TS_ACCOUNT_WORKERS'];
  else process.env['XLN_TS_ACCOUNT_WORKERS'] = priorWorkerCount;
  if (priorHubName === undefined) delete process.env['XLN_HUB_NAME'];
  else process.env['XLN_HUB_NAME'] = priorHubName;
});

describe('TS Account worker installation', () => {
  test('explicit zero keeps a sovereign Runtime on the canonical inline transition', () => {
    process.env['XLN_TS_ACCOUNT_WORKERS'] = '0';
    const env = createEmptyEnv('ts-inline-sovereign-runtime');

    installTsAccountWorkerAuthority(env);

    expect(env.accountAuthorityExecutionMode).toBeUndefined();
    expect(env.accountAuthorityEntityStageProvider).toBeUndefined();
  });

  test('H1 rejects the inline path because Stage 2 requires its resident worker pool', () => {
    process.env['XLN_TS_ACCOUNT_WORKERS'] = '0';
    process.env['XLN_HUB_NAME'] = 'H1';
    const env = createEmptyEnv('ts-h1-worker-required');

    expect(() => installTsAccountWorkerAuthority(env))
      .toThrow('TS_H1_BOOK_WORKER_PROVIDER_REQUIRED');
  });
});
