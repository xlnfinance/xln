import { afterEach, describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime';
import { installTsAccountWorkerAuthority } from '../../../rscore/ts-worker/provider';

const priorWorkerCount = process.env['XLN_TS_ACCOUNT_WORKERS'];

afterEach(() => {
  if (priorWorkerCount === undefined) delete process.env['XLN_TS_ACCOUNT_WORKERS'];
  else process.env['XLN_TS_ACCOUNT_WORKERS'] = priorWorkerCount;
});

describe('TS Account worker installation', () => {
  test('explicit zero keeps a sovereign Runtime on the canonical inline transition', () => {
    process.env['XLN_TS_ACCOUNT_WORKERS'] = '0';
    const env = createEmptyEnv('ts-inline-sovereign-runtime');

    installTsAccountWorkerAuthority(env);

    expect(env.accountAuthorityExecutionMode).toBeUndefined();
    expect(env.accountAuthorityEntityStageProvider).toBeUndefined();
  });
});
