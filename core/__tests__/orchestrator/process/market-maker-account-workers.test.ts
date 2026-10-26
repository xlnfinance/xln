import { afterEach, describe, expect, test } from 'bun:test';
import {
  MARKET_MAKER_TS_ACCOUNT_WORKERS,
  buildMarketMakerAccountWorkerEnv,
} from '../../../orchestrator/process/spawn/market-maker';
import { canonicalTsAccountWorkerCount } from '../../../runtime/workers/account/provider';

const previous = process.env['XLN_TS_ACCOUNT_WORKERS'];

afterEach(() => {
  if (previous === undefined) delete process.env['XLN_TS_ACCOUNT_WORKERS'];
  else process.env['XLN_TS_ACCOUNT_WORKERS'] = previous;
});

describe('market maker account worker pool', () => {
  // Each MM Entity owns one Account per hub and gets its own worker pool, so
  // the default 8-isolate pool per Entity booted ~48 idle isolates inside the
  // first bootstrap frame of every co-located stack.
  test('spawns the MM with one account worker per Entity by default', () => {
    expect(buildMarketMakerAccountWorkerEnv({})).toEqual({ XLN_TS_ACCOUNT_WORKERS: '1' });
    process.env['XLN_TS_ACCOUNT_WORKERS'] = MARKET_MAKER_TS_ACCOUNT_WORKERS;
    expect(canonicalTsAccountWorkerCount()).toBe(1);
  });

  test('keeps an explicit operator pool size', () => {
    expect(buildMarketMakerAccountWorkerEnv({ XLN_TS_ACCOUNT_WORKERS: '4' }))
      .toEqual({ XLN_TS_ACCOUNT_WORKERS: '4' });
  });
});
