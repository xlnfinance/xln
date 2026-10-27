import { expect, test } from 'bun:test';
import type { CrossJurisdictionSwapRoute } from '@xln/core/types/cross-jurisdiction';
import type { WalletView } from '../runtime/views';
import { TOUR_STEPS } from './steps';

import { owner, company, frame, wallet, account, token, context, done, withClaim } from './fixtures';

test('opening screens, entering amounts and submitted notices never complete financial chapters', () => {
  for (const chapter of TOUR_STEPS.filter(row => row.done && !['faucet', 'pay', 'trade'].includes(row.id))) {
    expect(done(chapter.id, context())).toBe(false);
    expect(done(chapter.id, context({ before: undefined }))).toBe(false);
  }
});

test('credit requires a higher signed limit on the same account and a newer committed frame', () => {
  const before = wallet({ accounts: [account({ tokens: [token(100n)] })] });
  const after = wallet({ frameHeight: 11, accounts: [account({ frameHeight: 2, tokens: [token(101n)] })] });
  expect(done('limits', context({ before, wallet: after }))).toBe(true);
  expect(done('limits', context({ before, wallet: { ...after, frameHeight: 10 } }))).toBe(false);
  expect(done('limits', context({ before, wallet: { ...after, accounts: [account({ tokens: [token(100n)] })] } }))).toBe(false);
  expect(done('limits', context({ before, wallet: { ...after, entityId: company } }))).toBe(false);
});

test('reserve moves require both committed legs; pending batch or external credit alone is insufficient', () => {
  const before = wallet({ frame: frame(owner, new Map([[1, 10_000_000n]])) });
  const after = wallet({
    frameHeight: 11,
    frame: frame(owner, new Map([[1, 5_000_000n]])),
    accounts: [account({ tokens: [token(0n, 5_000_000n)] })],
  });
  expect(done('move', context({ before, wallet: after }))).toBe(true);
  expect(done('move', context({ before, wallet: { ...after, accounts: [] } }))).toBe(false);
  expect(done('move', context({ before, wallet: { ...after, frame: before.frame } }))).toBe(false);
  const external = { tokenId: 1, amount: 5_000_000n, pending: 0n, jurisdiction: 'Testnet' };
  expect(done('withdraw', context({ before, wallet: { ...after, onchain: [external] } }))).toBe(true);
  expect(done('withdraw', context({ before, wallet: after }))).toBe(false);
  expect(done('withdraw', context({ before, wallet: { ...after, frame: before.frame, onchain: [external] } }))).toBe(false);
  expect(done('cover', context({ before, wallet: after }))).toBe(true);
});

test('a USDC position increase alone does not prove an invoice payment', () => {
  const before = wallet({ accounts: [account({ tokens: [token(0n, 0n, 10n)] })] });
  const after = wallet({ frameHeight: 11, accounts: [account({ tokens: [token(0n, 0n, 5_000_010n)] })] });
  expect(done('receive', context({ before, wallet: after }))).toBe(false);
  expect(done('receive', context({ before, wallet: { ...after, frameHeight: 10 } }))).toBe(false);
});

for (const [chapter, kind, creditorIsLeft] of [
  ['lending', 'demand', true],
  ['borrow', 'loan', false],
] as const) {
  test(`${chapter} requires a new funded signed covenant with the correct creditor`, () => {
    const after = withClaim(kind, creditorIsLeft);
    expect(done(chapter, context({ wallet: after }))).toBe(true);
    expect(done(chapter, context({ wallet: after, before: after }))).toBe(false);
    expect(done(chapter, context({ wallet: withClaim(kind, !creditorIsLeft) }))).toBe(false);
    expect(done(chapter, context({ wallet: withClaim(kind, creditorIsLeft, 10) }))).toBe(false);
  });
}
for (const [chapter, kind, creditorIsLeft] of [
  ['savings-withdraw', 'demand', true],
  ['repay', 'loan', false],
] as const) {
  test(`${chapter} requires an existing claim to close in committed state`, () => {
    const before = withClaim(kind, creditorIsLeft, 10);
    expect(done(chapter, context({ before }))).toBe(true);
    expect(done(chapter, context({ before, wallet: { ...before, frameHeight: 11 } }))).toBe(false);
    expect(done(chapter, context())).toBe(false);
  });
}

test('company needs a newly registered committed identity; pending registration is insufficient', () => {
  const after = wallet({ entityId: company, frame: frame(company) });
  expect(done('company', context({ wallet: after }))).toBe(true);
  expect(done('company', context())).toBe(false);
  expect(done('company', context({ wallet: { ...after, frame: frame(owner) } }))).toBe(false);
  expect(
    done('company', context({ wallet: after, before: wallet({ summaries: [{ entityId: company }] as WalletView['summaries'] }) })),
  ).toBe(false);
});

test('backup and export require actual current owner evidence, not enabled settings', () => {
  expect(done('protection', context({ backup: { runtimeId: 'runtime', entityId: owner, height: 10, storedBytes: 100 } }))).toBe(true);
  expect(done('protection', context({ backup: { runtimeId: 'runtime', entityId: owner, height: 9, storedBytes: 100 } }))).toBe(false);
  expect(done('protection', context({ backup: { runtimeId: 'runtime', entityId: company, height: 11, storedBytes: 100 } }))).toBe(false);
  expect(done('evidence', context({ exported: { runtimeId: 'runtime', entityId: owner, height: 10 } }))).toBe(true);
  expect(done('evidence', context({ exported: { runtimeId: 'runtime', entityId: owner, height: 9 } }))).toBe(false);
  expect(
    done(
      'recovery',
      context({
        restored: { runtimeId: 'runtime', entityIds: [owner], height: 10 },
        wallet: wallet({ frameHeight: 11, accounts: [account()] }),
      }),
    ),
  ).toBe(false);
  expect(done('recovery', context({ restored: { runtimeId: 'runtime', entityIds: [company], height: 10 } }))).toBe(false);
});

test('hubs require a new countersigned account; governance requires observed activation', () => {
  expect(done('hubs', context({ wallet: wallet({ frameHeight: 11, accounts: [account()] }) }))).toBe(true);
  expect(
    done('hubs', context({ before: wallet({ accounts: [account()] }), wallet: wallet({ frameHeight: 11, accounts: [account()] }) })),
  ).toBe(false);
  expect(
    done(
      'governance',
      context({ governance: { runtimeId: 'runtime', entityId: owner, targetId: company, oldHash: 'old', newHash: 'new' } }),
    ),
  ).toBe(true);
  expect(
    done(
      'governance',
      context({ governance: { runtimeId: 'runtime', entityId: owner, targetId: company, oldHash: 'old', newHash: 'old' } }),
    ),
  ).toBe(false);
});

test('cross orders need a new owned terminal route; an open or historical order is insufficient', () => {
  const route = (status: 'resting' | 'settled' | 'cancelled', entityId = owner) => ({ status, source: { entityId } });
  const withOrder = (status: 'resting' | 'settled' | 'cancelled', entityId = owner) => {
    const view = frame();
    view.activeEntity!.core.crossJurisdictionSwaps = new Map([['order', route(status, entityId) as CrossJurisdictionSwapRoute]]);
    return wallet({ frameHeight: 11, frame: view });
  };
  expect(done('cross', context({ wallet: withOrder('settled') }))).toBe(true);
  expect(done('cross', context({ wallet: withOrder('cancelled') }))).toBe(true);
  expect(done('cross', context({ wallet: withOrder('resting') }))).toBe(false);
  expect(done('cross', context({ wallet: withOrder('settled', company) }))).toBe(false);
  expect(done('cross', context({ before: withOrder('settled'), wallet: withOrder('settled') }))).toBe(false);
});

test('share release needs both registered share tokens and committed reserve growth', () => {
  const view = frame(
    owner,
    new Map([
      [8, 10n],
      [9, 10n],
    ]),
  );
  view.activeEntity!.core.entityProviderActionState = { version: 1, confirmedNonce: 1n, generation: 1 };
  const after = wallet({ frameHeight: 11, frame: view });
  const shareTokens = { runtimeId: 'runtime', entityId: owner, ids: [8, 9] };
  expect(done('shares', context({ wallet: after, shareTokens }))).toBe(true);
  expect(done('shares', context({ wallet: after }))).toBe(false);
  expect(done('shares', context({ wallet: after, shareTokens: { runtimeId: 'runtime', entityId: owner, ids: [8] } }))).toBe(false);
  expect(done('shares', context({ wallet: after, shareTokens: { runtimeId: 'runtime', entityId: company, ids: [8, 9] } }))).toBe(false);
  // Nonce 0 is the initial state, not a confirmed release.
  view.activeEntity!.core.entityProviderActionState.confirmedNonce = 0n;
  expect(done('shares', context({ wallet: after, shareTokens }))).toBe(false);
  view.activeEntity!.core.reserves.set(9, 0n);
  expect(done('shares', context({ wallet: after, shareTokens }))).toBe(false);
});

test('dispute submission never completes exit; finalized closure must have a reserve receipt', () => {
  const before = wallet({ accounts: [account()] });
  const after = wallet({ frameHeight: 11, accounts: [account({ dispute: 'closed' })], frame: frame(owner, new Map([[1, 5n]])) });
  expect(done('dispute', context({ before, wallet: after }))).toBe(true);
  expect(done('dispute', context({ before, wallet: { ...after, frame: frame() } }))).toBe(false);
  expect(done('dispute', context({ before, wallet: { ...after, accounts: [account({ dispute: 'active' })] } }))).toBe(false);
});
