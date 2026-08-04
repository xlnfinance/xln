import { expect, test } from 'bun:test';

import {
  assertSwapConfirmationCurrent,
  createSwapRequestCoordinator,
  createSwapRequestIdentity,
} from '../../frontend/apps/wallet/src/features/swap/swap-request-identity';

const identity = (overrides: Record<string, unknown> = {}) => createSwapRequestIdentity({
  frameHeight: 20,
  sourceEntityId: '0xsource',
  sourceAccountHeight: 8,
  sourceHubEntityId: '0xhub',
  mode: 'same',
  targetEntityId: null,
  targetAccountHeight: null,
  targetHubEntityId: null,
  giveTokenId: 1,
  wantTokenId: 2,
  giveAmountRaw: 100n,
  priceTicks: 25n,
  routeValue: 'same:0xsource:0xhub',
  ...overrides,
} as Parameters<typeof createSwapRequestIdentity>[0]);

test('swap identity binds exact route, amounts, price, and committed evidence heights', () => {
  const base = identity();
  expect(identity()).toBe(base);
  expect(identity({ frameHeight: 21 })).not.toBe(base);
  expect(identity({ sourceAccountHeight: 9 })).not.toBe(base);
  expect(identity({ giveAmountRaw: 101n })).not.toBe(base);
  expect(identity({ priceTicks: 26n })).not.toBe(base);
  expect(identity({ sourceHubEntityId: '0xotherhub' })).not.toBe(base);
});

test('racing quote responses cannot replace the latest request', () => {
  const coordinator = createSwapRequestCoordinator();
  const firstIdentity = identity({ giveAmountRaw: 100n });
  const secondIdentity = identity({ giveAmountRaw: 200n });
  const first = coordinator.begin(firstIdentity);
  const second = coordinator.begin(secondIdentity);
  expect(coordinator.accepts(first, secondIdentity)).toBe(false);
  expect(coordinator.accepts(second, secondIdentity)).toBe(true);
  coordinator.invalidate();
  expect(coordinator.accepts(second, secondIdentity)).toBe(false);
});

test('confirmation rejects state or input changes after canonical planning', () => {
  const confirmed = identity();
  expect(() => assertSwapConfirmationCurrent(confirmed, identity({ frameHeight: 21 }))).toThrow(
    'WALLET_SWAP_CONFIRMATION_STALE',
  );
  expect(() => assertSwapConfirmationCurrent(confirmed, confirmed)).not.toThrow();
});

test('cross-j identity distinguishes an absent target account from committed account evidence', () => {
  const absent = identity({ mode: 'cross', targetEntityId: '0xtarget', targetHubEntityId: '0xhub2' });
  const committed = identity({
    mode: 'cross',
    targetEntityId: '0xtarget',
    targetHubEntityId: '0xhub2',
    targetAccountHeight: 4,
  });
  expect(absent).not.toBe(committed);
});
