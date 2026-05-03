import { expect, test } from 'bun:test';
import { MarketSubscriptionLimiter } from '../market-subscription-limiter';

test('market subscription limiter enforces global and per-ip caps', () => {
  const limiter = new MarketSubscriptionLimiter(3, 2, 64);

  expect(limiter.canOpen('10.0.0.1').ok).toBe(true);
  limiter.add('10.0.0.1');
  expect(limiter.canOpen('10.0.0.1').ok).toBe(true);
  limiter.add('10.0.0.1');
  expect(limiter.canOpen('10.0.0.1')).toEqual({
    ok: false,
    code: 'E_RATE_LIMITED',
    error: 'market subscription IP capacity exceeded: max=2',
  });

  expect(limiter.canOpen('10.0.0.2').ok).toBe(true);
  limiter.add('10.0.0.2');
  expect(limiter.canOpen('10.0.0.3')).toEqual({
    ok: false,
    code: 'E_RATE_LIMITED',
    error: 'market subscription capacity exceeded',
  });

  expect(limiter.snapshot()).toEqual({
    total: 3,
    byIp: { '10.0.0.1': 2, '10.0.0.2': 1 },
    maxTotal: 3,
    maxPerIp: 2,
    maxCellsPerSubscription: 64,
  });

  limiter.remove('10.0.0.1');
  expect(limiter.canOpen('10.0.0.3').ok).toBe(true);
  limiter.clear();
  expect(limiter.snapshot().total).toBe(0);
});
