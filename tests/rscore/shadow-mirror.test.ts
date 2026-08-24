/**
 * Shadow mirror lifecycle against the live Rust process: first sight
 * registers via UpsertAccounts, supported frames replay as waves and the
 * per-account root must match the TS authority, a divergence flags the
 * account and the next frame reseeds it, after which comparison recovers.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { applyAccountTxToMutableReplica } from '../../core/account/tx/apply';
import { computeAccountStateRoot } from '../../core/account/commitment/state-root';
import { createDefaultDelta } from '../../core/account/state/delta';
import { PersistentAccountStateMap } from '../../core/account/state/persistent-state-map';
import { hashHtlcSecret } from '../../core/protocol/htlc/utils';
import type { AccountReplica, AccountTx } from '../../core/types/account';
import { addr, entity, makeAccount } from '../../core/__tests__/helpers/cross-j';
import { RscoreProcessClient } from '../../core/rscore/client';
import { RscoreShadowMirror } from '../../core/rscore/shadow';

const BINARY = join(import.meta.dir, '../../rscore/target/release/xln-rscore');

const LEFT = entity('aa');
const RIGHT = entity('bb');
const SECRET = `0x${'77'.repeat(32)}`;

const makeMirror = (maxOwners = 1): RscoreShadowMirror => new RscoreShadowMirror({
  binaryPath: BINARY,
  workers: 2,
  maxOwners,
  makeClient: path => new RscoreProcessClient(path, {
    engineGeneration: Buffer.alloc(8, 0x5d),
    runtimeId: Buffer.alloc(20, 0x5d),
    sessionId: Buffer.alloc(16, 0x5d),
  }),
});

const makeTsAccount = (counterparty: string = RIGHT): AccountReplica => {
  const account = makeAccount(LEFT, counterparty, { chainId: 31_337, depositoryAddress: addr('88') });
  account.state.watchSeed = entity('99');
  account.state.deltas = PersistentAccountStateMap.fromEntries('deltas', [
    [1, { ...createDefaultDelta(1), collateral: 1_000_000n }],
  ]);
  return account;
};

/** Canonical-direction payment for whichever pair this account holds. */
const paymentFor = (account: AccountReplica, amount: bigint): AccountTx => ({
  type: 'direct_payment',
  data: {
    tokenId: 1,
    amount,
    route: [account.state.leftEntity],
    description: 'shadow',
    fromEntityId: account.state.rightEntity,
    toEntityId: account.state.leftEntity,
    deliveryMode: 'direct',
  },
});

const payment = (amount: bigint): AccountTx => ({
  type: 'direct_payment',
  data: {
    tokenId: 1,
    amount,
    route: [LEFT],
    description: 'shadow',
    fromEntityId: RIGHT,
    toEntityId: LEFT,
    deliveryMode: 'direct',
  },
});

describe.skipIf(!existsSync(BINARY))('rscore shadow mirror', () => {
  test('register, match, diverge, reseed, recover — plus HTLC frames', async () => {
    const account = makeTsAccount();
    const mirror = makeMirror();
    let height = 0;

    const commitFrame = async (
      txs: AccountTx[],
      overrides: { expectedRoot?: string; byLeft?: boolean; jHeight?: number } = {},
    ): Promise<void> => {
      height += 1;
      const byLeft = overrides.byLeft ?? false;
      const timestamp = 1_700_000_000_000 + height;
      const jHeight = overrides.jHeight ?? 0;
      for (const tx of txs) {
        const result = await applyAccountTxToMutableReplica(
          account, tx, byLeft, timestamp, jHeight, false, undefined, undefined, undefined,
          { timestamp, jHeight },
        );
        if (!result.ok) throw new Error(`TS_APPLY_FAILED:${result.rejection.code}`);
      }
      account.currentHeight = height; // consensus bumps this at frame commit
      mirror.noteCommittedFrame({
        ownerEntityId: LEFT,
        counterpartyEntityId: RIGHT,
        frameHeight: height,
        byLeft,
        timestamp,
        jHeight,
        enforcementTimestamp: timestamp,
        enforcementJHeight: jHeight,
        accountTxs: txs,
        committedStateRoot: overrides.expectedRoot ?? computeAccountStateRoot(account.state),
        account,
      });
      await mirror.settled();
    };

    // Frame 1: first sight -> register (no comparison).
    await commitFrame([payment(10n)]);
    // Frames 2-3: replayed waves must match the TS root.
    await commitFrame([payment(11n)]);
    await commitFrame([payment(12n), payment(13n)]);
    // Frame 4: forced divergence.
    await commitFrame([payment(14n)], { expectedRoot: `0x${'ee'.repeat(32)}` });
    // Frame 5: reseeds from the committed snapshot.
    await commitFrame([payment(15n)]);
    // Frame 6: comparison recovered.
    await commitFrame([payment(16n)]);
    // Frames 7-8: HTLC lock then secret resolve, proposed by left.
    const hashlock = hashHtlcSecret(SECRET);
    await commitFrame([{
      type: 'htlc_lock',
      data: { lockId: 'shadow-lock-1', hashlock, timelock: 9_999_999_999_999n, revealBeforeHeight: 1_000_000, amount: 7n, tokenId: 1 },
    }], { byLeft: true });
    await commitFrame([{
      type: 'htlc_resolve',
      data: { lockId: 'shadow-lock-1', outcome: 'secret', secret: SECRET },
    }], { byLeft: false });

    const stats = mirror.stats();
    await mirror.shutdown();
    expect(stats.disabledReason).toBeNull();
    expect(stats.framesSeen).toBe(8);
    expect(stats.reseeds).toBe(2); // register + post-divergence reseed
    expect(stats.framesCompared).toBe(6);
    expect(stats.mismatches).toBe(1);
    expect(stats.matches).toBe(5);
    expect(stats.dropped).toBe(0);
    expect(stats.skippedUnboundOwner).toBe(0);
  }, 30_000);

  // Whole-tree reconciliation after a deterministic run: every account the
  // engine holds is compared against the TypeScript map leaf by leaf, so a
  // skipped or diverged account surfaces as a gap instead of passing silently.
  test('reconciles the whole accounts tree and names every gap', async () => {
    const mirror = makeMirror(1);
    const mirrored = makeTsAccount(RIGHT);
    const drifted = makeTsAccount(entity('cd'));
    const never = makeTsAccount(entity('ce'));
    const counterparties = new Map<string, AccountReplica>([
      [RIGHT, mirrored],
      [entity('cd'), drifted],
      [entity('ce'), never],
    ]);
    let height = 0;
    const commit = async (counterparty: string, account: AccountReplica): Promise<void> => {
      height += 1;
      const timestamp = 1_700_000_000_000 + height;
      const tx = paymentFor(account, 5n);
      const result = await applyAccountTxToMutableReplica(
        account, tx, false, timestamp, 0, false, undefined, undefined, undefined,
        { timestamp, jHeight: 0 },
      );
      if (!result.ok) throw new Error(`TS_APPLY_FAILED:${result.rejection.code}`);
      account.currentHeight = height;
      mirror.noteCommittedFrame({
        ownerEntityId: LEFT,
        counterpartyEntityId: counterparty,
        frameHeight: height,
        byLeft: false,
        timestamp,
        jHeight: 0,
        enforcementTimestamp: timestamp,
        enforcementJHeight: 0,
        accountTxs: [tx],
        committedStateRoot: computeAccountStateRoot(account.state),
        account,
      });
      await mirror.settled();
    };

    await commit(RIGHT, mirrored);
    await commit(entity('cd'), drifted);
    // Drift the TypeScript side only: the engine keeps the seeded state.
    const drift = await applyAccountTxToMutableReplica(
      drifted, paymentFor(drifted, 9n), false, 1_700_000_009_999, 0, false, undefined, undefined, undefined,
      { timestamp: 1_700_000_009_999, jHeight: 0 },
    );
    if (!drift.ok) throw new Error('TS_DRIFT_FAILED');
    // `never` is never mirrored at all.

    const report = await mirror.reconcile(LEFT, counterparties);
    const stats = mirror.stats();
    await mirror.shutdown();
    expect(stats.disabledReason).toBeNull();
    expect(report.matched).toBe(1);
    expect(report.mismatched.map(entry => entry.accountId)).toEqual([entity('cd')]);
    expect(report.mismatched[0]?.deltasRoot.typescript)
      .not.toBe(report.mismatched[0]?.deltasRoot.rust);
    expect(report.missingInEngine).toEqual([entity('ce')]);
    expect(report.extraInEngine).toEqual([]);
  }, 30_000);

  // A stand with many entities must not fork one engine per entity: the
  // mirror binds to the first maxOwners owners and ignores the rest.
  test('binds a bounded number of owner entities', async () => {
    const mirror = makeMirror(1);
    const first = makeTsAccount();
    const second = makeTsAccount();
    const note = (owner: string, counterparty: string, account: AccountReplica): void => {
      mirror.noteCommittedFrame({
        ownerEntityId: owner,
        counterpartyEntityId: counterparty,
        frameHeight: 1,
        byLeft: false,
        timestamp: 1_700_000_000_000,
        jHeight: 0,
        enforcementTimestamp: 1_700_000_000_000,
        enforcementJHeight: 0,
        accountTxs: [payment(1n)],
        committedStateRoot: computeAccountStateRoot(account.state),
        account,
      });
    };
    note(LEFT, RIGHT, first);
    note(entity('cc'), RIGHT, second); // second owner: ignored
    await mirror.settled();
    const stats = mirror.stats();
    await mirror.shutdown();
    expect(stats.skippedUnboundOwner).toBe(1);
    expect(stats.reseeds).toBe(1);
    expect(stats.disabledReason).toBeNull();
  }, 30_000);
});
