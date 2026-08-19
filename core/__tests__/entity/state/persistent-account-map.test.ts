import { describe, expect, test } from 'bun:test';

import type { AccountReplica } from '../../../types/account';
import { applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import {
  PersistentAccountStateMap,
  requirePersistentAccountStateMap,
} from '../../../account/state/persistent-state-map';
import {
  EntityAccountCandidateMap,
  PersistentEntityAccountMap,
} from '../../../entity/state/persistent-account-map';
import { makeAccount } from '../../helpers/cross-j';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { listOpenSwapOffers } from '../../../orderbook/open-swap-offers';

const hash = (value: AccountReplica): string =>
  `0x${String((value as unknown as { marker: number }).marker).padStart(64, '0')}`;
const id = (suffix: string): string => `0x${suffix.padStart(64, '0')}`;
const LEFT = id('11');
const RIGHT = id('22');

const productionAccount = (): AccountReplica => {
  const replica = makeAccount(LEFT, RIGHT);
  delete (replica as { swapOrderHistory?: unknown }).swapOrderHistory;
  delete (replica as { swapClosedOrders?: unknown }).swapClosedOrders;
  replica.pendingWithdrawals = PersistentAccountStateMap.fromEntries(
    'pendingWithdrawals',
    replica.pendingWithdrawals,
  );
  replica.shadow.rebalance.policy = PersistentAccountStateMap.fromEntries(
    'rebalanceShadowPolicy',
    replica.shadow.rebalance.policy,
  );
  replica.shadow.rebalance.submittedAtByToken = PersistentAccountStateMap.fromEntries(
    'rebalanceShadowSubmitted',
    replica.shadow.rebalance.submittedAtByToken,
  );
  return replica;
};

const account = (marker: number): AccountReplica => Object.assign(productionAccount(), { marker });

const offdeltaHash = (value: AccountReplica): string =>
  `0x${(value.state.deltas.get(1)?.offdelta ?? 0n).toString(16).padStart(64, '0')}`;

describe('PersistentEntityAccountMap', () => {
  test('orderbook discovery reads committed Patricia Account collections', () => {
    const replica = productionAccount();
    replica.state.swapOffers = replica.state.swapOffers.updated('offer-1', {
      offerId: 'offer-1',
      giveTokenId: 1,
      giveTokenDecimals: 6,
      giveAmount: 10_000_000n,
      wantTokenId: 2,
      wantTokenDecimals: 18,
      wantAmount: 4_000_000_000_000_000n,
      maxFee: 0n,
      minNetReceive: 4_000_000_000_000_000n,
      priceTicks: 2_500_000n,
      makerIsLeft: true,
      createdHeight: 7,
      quantizedGive: 10_000_000n,
      quantizedWant: 4_000_000_000_000_000n,
    });
    const accounts = PersistentEntityAccountMap.fromMap(
      new Map([[RIGHT, replica]]),
      LEFT,
      computeEntityAccountValueHash,
    );

    expect(listOpenSwapOffers({ accounts })).toEqual([expect.objectContaining({
      offerId: 'offer-1',
      accountId: RIGHT,
      createdHeight: 7,
    })]);
  });

  test('rejection leaves the committed base unchanged', () => {
    const alice = id('1');
    const base = PersistentEntityAccountMap.fromMap(
      new Map([[alice, account(1)]]),
      LEFT,
      hash,
    );
    const overlay = new EntityAccountCandidateMap(base);
    overlay.set(alice, account(2));

    expect(base instanceof Map).toBe(false);
    expect(overlay instanceof Map).toBe(false);
    expect((base.get(alice) as unknown as { marker: number }).marker).toBe(1);
    expect((overlay.get(alice) as unknown as { marker: number }).marker).toBe(2);
  });

  test('getForWrite dirties one Account and shares the committed collection root', () => {
    const alice = id('1');
    const bob = id('2');
    const bobAccount = productionAccount();
    const aliceAccount = productionAccount();
    const base = PersistentEntityAccountMap.fromMap(
      new Map([[alice, aliceAccount], [bob, bobAccount]]),
      LEFT,
      offdeltaHash,
    );
    const overlay = new EntityAccountCandidateMap(base);
    expect(overlay.stats()).toEqual({ base: 2, changed: 0, deleted: 0 });
    expect(overlay.get(alice)).toBe(base.get(alice));

    const shell = overlay.getForWrite(alice);
    if (!shell) throw new Error('TEST_WRITE_SHELL_MISSING');
    shell.status = 'disputed';

    expect(overlay.stats()).toEqual({ base: 2, changed: 1, deleted: 0 });
    expect(overlay.dirtyKeys()).toEqual(new Set([alice]));
    expect(shell.state.deltas).toBe(base.get(alice)?.state.deltas);
    expect(base.get(alice)?.status).toBe('active');
    expect(overlay.get(bob)).toBe(base.get(bob));
  });

  test('seal writes only the claimed shell and preserves the old committed view', () => {
    const alice = id('1');
    const bob = id('2');
    const bobAccount = account(2);
    const base = PersistentEntityAccountMap.fromMap(
      new Map([[alice, account(1)], [bob, bobAccount]]),
      LEFT,
      hash,
    );
    const overlay = new EntityAccountCandidateMap(base);
    overlay.set(alice, account(3));
    const committed = overlay.sealCandidate();

    expect((base.get(alice) as unknown as { marker: number }).marker).toBe(1);
    expect((committed.get(alice) as unknown as { marker: number }).marker).toBe(3);
    expect(committed.get(bob)).toBe(bobAccount);
    expect(committed.rootHash()).not.toBe(base.rootHash());
  });

  test('size does not hash; rootHash hashes only the dirty Account and seal reuses that projection', () => {
    const alice = id('1');
    let hashes = 0;
    const countedHash = (value: AccountReplica): string => {
      hashes += 1;
      return hash(value);
    };
    const base = PersistentEntityAccountMap.fromMap(new Map([[alice, account(1)]]), LEFT, countedHash);
    const overlay = new EntityAccountCandidateMap(base);
    hashes = 0;
    overlay.set(alice, account(2));

    expect(overlay.size).toBe(1);
    expect(hashes).toBe(0);
    overlay.rootHash();
    expect(hashes).toBe(1);
    // No write after the hash: seal commits the already hashed projection.
    overlay.sealCandidate();
    expect(hashes).toBe(1);
  });

  test('one publication folds 1,000 dirty Accounts with canonical root order', () => {
    const total = 1_000;
    let hashes = 0;
    const countedHash = (value: AccountReplica): string => {
      hashes += 1;
      return hash(value);
    };
    const base = PersistentEntityAccountMap.empty(LEFT, countedHash);
    const ascending = new EntityAccountCandidateMap(base);
    const descending = new EntityAccountCandidateMap(base);
    for (let index = 1; index <= total; index += 1) {
      ascending.set(id(index.toString(16)), account(index));
    }
    for (let index = total; index >= 1; index -= 1) {
      descending.set(id(index.toString(16)), account(index));
    }

    const asc = ascending.sealCandidate();
    expect(asc.size).toBe(total);
    expect(hashes).toBe(0);
    const ascRoot = asc.hash;
    expect(hashes).toBe(total);
    const desc = descending.sealCandidate();
    expect(desc.size).toBe(total);
    expect(desc.hash).toBe(ascRoot);
    expect(hashes).toBe(total * 2);
    expect(base.size).toBe(0);
  });

  test('committed Account top-level alias mutation is rejected', () => {
    const alice = id('1');
    const stored = account(1);
    const base = PersistentEntityAccountMap.fromMap(new Map([[alice, stored]]), LEFT, hash);
    const root = base.rootHash();
    expect(() => {
      (stored as unknown as { marker: number }).marker = 9;
    }).toThrow();
    expect(base.rootHash()).toBe(root);
    expect((base.get(alice) as unknown as { marker: number }).marker).toBe(1);
    expect(() => {
      Object.defineProperty(stored, 'marker', { value: 7 });
    }).toThrow();
    expect(() => {
      (stored as unknown as { extra?: number }).extra = 1;
    }).toThrow();
  });

  test('committed PersistentAccountStateMap leaf stays immutable and unclaimed get allocates nothing', () => {
    const replica = productionAccount();
    const base = PersistentEntityAccountMap.fromMap(
      new Map([[RIGHT, replica]]),
      LEFT,
      computeEntityAccountValueHash,
    );
    const stored = base.get(RIGHT);
    if (!stored) throw new Error('TEST_ACCOUNT_MISSING');
    expect(() => {
      stored.status = 'disputed';
    }).toThrow();
    expect(() => {
      stored.state.jNonce = 9;
    }).toThrow();
    expect(() => {
      stored.proofHeader.nextProofNonce = 9;
    }).toThrow();
    expect(() => {
      stored.currentFrame.accountTxs.push({} as never);
    }).toThrow();
    const committedDelta = stored.state.deltas.get(1);
    if (!committedDelta) throw new Error('TEST_DELTA_MISSING');
    expect(() => {
      committedDelta.offdelta = 9n;
    }).toThrow();
    expect(typeof (stored.state.deltas as { set?: unknown }).set).toBe('undefined');

    const overlay = new EntityAccountCandidateMap(base);
    expect(overlay.get(RIGHT)).toBe(stored);
    expect(() => {
      const visible = overlay.get(RIGHT);
      if (!visible) throw new Error('TEST_ACCOUNT_MISSING');
      visible.status = 'disputed';
    }).toThrow();
    expect(overlay.stats().changed).toBe(0);
  });

  test('claimed Entity shell cannot mutate a committed Account leaf by alias', () => {
    const base = PersistentEntityAccountMap.fromMap(
      new Map([[RIGHT, productionAccount()]]),
      LEFT,
      computeEntityAccountValueHash,
    );
    const overlay = new EntityAccountCandidateMap(base);
    const shell = overlay.getForWrite(RIGHT);
    if (!shell) throw new Error('TEST_WRITE_SHELL_MISSING');
    const sharedDelta = shell.state.deltas.get(1);
    if (!sharedDelta) throw new Error('TEST_DELTA_MISSING');

    expect(() => {
      sharedDelta.offdelta += 1n;
    }).toThrow();
    expect(overlay.stats()).toEqual({ base: 1, changed: 1, deleted: 0 });
    expect(shell.state.deltas).toBe(base.get(RIGHT)?.state.deltas);
  });

  test('direct Account state transitions publish into the Entity write shell', async () => {
    const replica = productionAccount();
    const base = PersistentEntityAccountMap.fromMap(new Map([[RIGHT, replica]]), LEFT, offdeltaHash);
    const overlay = new EntityAccountCandidateMap(base);
    const shell = overlay.getForWrite(RIGHT);
    if (!shell) throw new Error('TEST_WRITE_SHELL_MISSING');

    const result = await applyAccountTxToMutableReplica(shell, {
      type: 'add_delta',
      data: { tokenId: 2 },
    }, true);
    expect(result.ok).toBe(true);
    expect(shell.state.deltas.has(2)).toBe(true);
    expect(base.get(RIGHT)?.state.deltas.has(2)).toBe(false);

    const committed = overlay.sealCandidate();
    expect(committed.get(RIGHT)?.state.deltas.has(2)).toBe(true);
    expect(base.get(RIGHT)?.state.deltas.has(2)).toBe(false);
    expect(committed.get(RIGHT)?.state.deltas).not.toBe(base.get(RIGHT)?.state.deltas);
  });

  test('envelope Patricia roots dirty explicitly while signature-only witness bytes keep the same root', () => {
    const replica = productionAccount();
    const withdrawal = {
      requestId: 'withdraw-1',
      tokenId: 1,
      amount: 7n,
      requestedAt: 10,
      direction: 'outgoing' as const,
      status: 'approved' as const,
      signature: '0xaaa',
    };
    replica.pendingWithdrawals = requirePersistentAccountStateMap(
      replica.pendingWithdrawals,
      'pendingWithdrawals',
    ).updated(withdrawal.requestId, withdrawal);
    const base = PersistentEntityAccountMap.fromMap(
      new Map([[RIGHT, replica]]),
      LEFT,
      computeEntityAccountValueHash,
    );
    const baseRoot = base.rootHash();

    const overlay = new EntityAccountCandidateMap(base);
    const shell = overlay.getForWrite(RIGHT);
    if (!shell) throw new Error('TEST_WRITE_SHELL_MISSING');
    shell.pendingWithdrawals = requirePersistentAccountStateMap(
      shell.pendingWithdrawals,
      'pendingWithdrawals',
    ).updated(withdrawal.requestId, { ...withdrawal, signature: '0xbbb' });
    const committed = overlay.sealCandidate();

    expect(committed.rootHash()).toBe(baseRoot);
    expect(committed.get(RIGHT)?.pendingWithdrawals.get(withdrawal.requestId)?.signature).toBe('0xbbb');
    expect(base.get(RIGHT)?.pendingWithdrawals.get(withdrawal.requestId)?.signature).toBe('0xaaa');
    expect(typeof (committed.get(RIGHT)?.pendingWithdrawals as { set?: unknown }).set).toBe('undefined');
  });

  test('root projection cannot freeze the writable AccountInput Hanko draft', () => {
    const base = PersistentEntityAccountMap.fromMap(
      new Map([[RIGHT, productionAccount()]]),
      LEFT,
      computeEntityAccountValueHash,
    );
    const overlay = new EntityAccountCandidateMap(base);
    const shell = overlay.getForWrite(RIGHT);
    if (!shell) throw new Error('TEST_WRITE_SHELL_MISSING');
    shell.pendingAccountInput = {
      fromEntityId: LEFT,
      toEntityId: RIGHT,
      domain: { ...shell.state.domain },
      disputeConfig: { ...shell.state.disputeConfig },
      kind: 'frame',
      proposal: { frame: { ...shell.currentFrame, accountTxs: [], deltas: [] } },
    };
    shell.lastOutboundFrameAck = {
      height: shell.currentHeight,
      counterpartyEntityId: RIGHT,
      response: {
        fromEntityId: LEFT,
        toEntityId: RIGHT,
        domain: { ...shell.state.domain },
        disputeConfig: { ...shell.state.disputeConfig },
        kind: 'ack',
        ack: { height: shell.currentHeight, frameHash: shell.currentFrame.stateHash },
      },
    };

    overlay.rootHash();
    shell.pendingAccountInput.proposal.frameHanko = `0x${'11'.repeat(65)}`;
    shell.lastOutboundFrameAck.response.ack.frameHanko = `0x${'22'.repeat(65)}`;

    expect(shell.pendingAccountInput.proposal.frameHanko).toBe(`0x${'11'.repeat(65)}`);
    expect(shell.lastOutboundFrameAck.response.ack.frameHanko).toBe(`0x${'22'.repeat(65)}`);
    expect(base.get(RIGHT)?.pendingAccountInput).toBeUndefined();
  });

  test('dropping the hash projection reseals in-place pendingFrame onto the committed leaf', () => {
    const replica = productionAccount();
    replica.currentHeight = 10;
    const overlay = new EntityAccountCandidateMap(PersistentEntityAccountMap.fromMap(
      new Map([[RIGHT, replica]]),
      LEFT,
      computeEntityAccountValueHash,
    ));
    const shell = overlay.getForWrite(RIGHT);
    if (!shell) throw new Error('TEST_WRITE_SHELL_MISSING');
    overlay.rootHash();
    shell.pendingFrame = { ...shell.currentFrame, height: 11, stateHash: `0x${'ab'.repeat(32)}` };
    overlay.dropCachedProjection();
    const committed = overlay.sealCandidate();

    expect(committed.get(RIGHT)?.pendingFrame?.height).toBe(11);
    expect(committed.get(RIGHT)?.pendingFrame?.stateHash).toBe(`0x${'ab'.repeat(32)}`);
  });
});
