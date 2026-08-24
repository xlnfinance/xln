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
import type { ApplyAccountTxOk } from '../../core/account/tx/apply-types';
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
const ERROR_SECRET = `0x${'78'.repeat(32)}`;

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

// A release gate sets XLN_RSCORE_REQUIRE_BINARY=1: an absent binary is then a
// failure, never a silent skip.
if (!existsSync(BINARY) && process.env['XLN_RSCORE_REQUIRE_BINARY'] === '1') {
  throw new Error(`RSCORE_BINARY_MISSING:${BINARY}`);
}

describe.skipIf(!existsSync(BINARY))('rscore shadow mirror', () => {
  test('restores the recovery checkpoint before comparing its first WAL frame', async () => {
    const account = makeTsAccount();
    const mirror = makeMirror();
    await mirror.primeOwner(LEFT, new Map([[RIGHT, account]]));
    const tx = payment(9n);
    const timestamp = 1_700_000_000_001;
    const result = await applyAccountTxToMutableReplica(
      account, tx, false, timestamp, 0, false, undefined, undefined, undefined,
      { timestamp, jHeight: 0 },
    );
    if (!result.ok) throw new Error(`TS_APPLY_FAILED:${result.rejection.code}`);
    account.currentHeight = 1;
    mirror.noteCommittedFrame({
      ownerEntityId: LEFT,
      counterpartyEntityId: RIGHT,
      frameHeight: 1,
      byLeft: false,
      timestamp,
      jHeight: 0,
      enforcementTimestamp: timestamp,
      enforcementJHeight: 0,
      accountTxs: [tx],
      txResults: [result],
      committedStateRoot: computeAccountStateRoot(account.state),
      account,
    });
    mirror.flushWave();
    await mirror.settled();
    const stats = mirror.stats();
    const report = await mirror.reconcile(LEFT, new Map([[RIGHT, account]]));
    await mirror.shutdown();
    expect(stats.reseeds).toBe(0);
    expect(stats.seededNeverExecuted).toBe(0);
    expect(stats.framesCompared).toBe(1);
    expect(stats.matches).toBe(1);
    expect(report.matched).toBe(1);
    expect(report.forestRoot.equal).toBeTrue();
  });

  test('register, match, diverge, reseed, recover — plus HTLC frames', async () => {
    const account = makeTsAccount();
    const mirror = makeMirror();
    let height = 0;

    const commitFrame = async (
      txs: AccountTx[],
      overrides: {
        expectedRoot?: string;
        byLeft?: boolean;
        jHeight?: number;
        txResults?: readonly ApplyAccountTxOk[];
      } = {},
    ): Promise<void> => {
      height += 1;
      const byLeft = overrides.byLeft ?? false;
      const timestamp = 1_700_000_000_000 + height;
      const jHeight = overrides.jHeight ?? 0;
      const txResults: ApplyAccountTxOk[] = [];
      for (const tx of txs) {
        const result = await applyAccountTxToMutableReplica(
          account, tx, byLeft, timestamp, jHeight, false, undefined, undefined, undefined,
          { timestamp, jHeight },
        );
        if (!result.ok) throw new Error(`TS_APPLY_FAILED:${result.rejection.code}`);
        txResults.push(result);
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
        // Direct-mode payments emit no forward; the resolve outcome rows come
        // from the TS apply results, exactly as the commit paths build them.
        txResults: overrides.txResults ?? txResults,
        committedStateRoot: overrides.expectedRoot ?? computeAccountStateRoot(account.state),
        account,
      });
      // Each commitFrame stands for one Runtime frame, so the wave is flushed
      // at its boundary exactly as the runtime does.
      mirror.flushWave();
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
    // Frames 7-8: two HTLCs then ordered secret+error results in one frame.
    // This proves output association by input index and compares every field
    // of both result variants (including an arbitrary delimiter in reason).
    const hashlock = hashHtlcSecret(SECRET);
    const errorHashlock = hashHtlcSecret(ERROR_SECRET);
    await commitFrame([
      {
        type: 'htlc_lock',
        data: { lockId: 'shadow-lock-1', hashlock, timelock: 9_999_999_999_999n, revealBeforeHeight: 1_000_000, amount: 7n, tokenId: 1 },
      },
      {
        type: 'htlc_lock',
        data: { lockId: 'shadow-lock-2', hashlock: errorHashlock, timelock: 9_999_999_999_999n, revealBeforeHeight: 1_000_000, amount: 8n, tokenId: 1 },
      },
    ], { byLeft: true });
    await commitFrame([
      {
        type: 'htlc_resolve',
        data: { lockId: 'shadow-lock-1', outcome: 'secret', secret: SECRET },
      },
      {
        type: 'htlc_resolve',
        data: { lockId: 'shadow-lock-2', outcome: 'error', reason: 'downstream|rejected' },
      },
    ], { byLeft: false });

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
    expect(stats.seededNeverExecuted).toBe(0);
    expect(stats.executedByType).toEqual({
      direct_payment: 5,
      htlc_lock: 2,
      htlc_resolve: 2,
    });
    // Every compared frame must carry a verdict; a compared frame with no
    // outcome means a stats snapshot raced the drain loop.
    expect(stats.matches + stats.mismatches).toBe(stats.framesCompared);
    // And every seen frame is accounted for by exactly one disposition.
    expect(
      stats.framesCompared + stats.reseeds + stats.emptyFrames
      + stats.skippedIneligible + stats.skippedUnboundOwner + stats.dropped,
    ).toBe(stats.framesSeen);
  }, 30_000);

  test('fails loudly when a committed tx has no authority result', async () => {
    const account = makeTsAccount();
    const mirror = makeMirror();
    mirror.noteCommittedFrame({
      ownerEntityId: LEFT,
      counterpartyEntityId: RIGHT,
      frameHeight: 1,
      byLeft: false,
      timestamp: 1_700_000_000_001,
      jHeight: 0,
      enforcementTimestamp: 1_700_000_000_001,
      enforcementJHeight: 0,
      accountTxs: [payment(1n)],
      txResults: [],
      committedStateRoot: computeAccountStateRoot(account.state),
      account,
    });
    expect(mirror.stats().disabledReason).toBe('note:SHADOW_TX_RESULT_LENGTH:0:1');
    await mirror.shutdown();
  });

  test('splits frame_ack commits into ordered subwaves and checks the intermediate root', async () => {
    const account = makeTsAccount();
    const mirror = makeMirror();
    let height = 0;
    const notePayment = async (amount: bigint, expectedRoot?: string): Promise<void> => {
      height += 1;
      const timestamp = 1_700_100_000_000 + height;
      const tx = payment(amount);
      const result = await applyAccountTxToMutableReplica(
        account, tx, false, timestamp, 0, false, undefined, undefined, undefined,
        { timestamp, jHeight: 0 },
      );
      if (!result.ok) throw new Error(`TS_APPLY_FAILED:${result.rejection.code}`);
      account.currentHeight = height;
      mirror.noteCommittedFrame({
        ownerEntityId: LEFT,
        counterpartyEntityId: RIGHT,
        frameHeight: height,
        byLeft: false,
        timestamp,
        jHeight: 0,
        enforcementTimestamp: timestamp,
        enforcementJHeight: 0,
        accountTxs: [tx],
        txResults: [result],
        committedStateRoot: expectedRoot ?? computeAccountStateRoot(account.state),
        account,
      });
    };

    // Registration is its own Runtime frame.
    await notePayment(1n);
    mirror.flushWave();
    await mirror.settled();

    // Canonical frame_ack processing can commit the ACKed pending frame and
    // the peer's next proposal before the same Runtime boundary. Corrupt only
    // the first claimed root: the second/final root remains correct, so this
    // proves the intermediate frame is checked instead of folded away.
    await notePayment(2n, `0x${'ee'.repeat(32)}`);
    await notePayment(3n);
    mirror.flushWave();
    await mirror.settled();

    const stats = mirror.stats();
    const report = await mirror.reconcile(LEFT, new Map([[RIGHT, account]]));
    await mirror.shutdown();
    expect(stats.disabledReason).toBeNull();
    expect(stats.framesSeen).toBe(3);
    expect(stats.reseeds).toBe(1);
    expect(stats.framesCompared).toBe(2);
    expect(stats.mismatches).toBe(1);
    expect(stats.matches).toBe(1);
    expect(report.matched).toBe(1);
    expect(report.forestRoot.equal).toBe(true);
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
        txResults: [result],
        committedStateRoot: computeAccountStateRoot(account.state),
        account,
      });
      // Each commitFrame stands for one Runtime frame, so the wave is flushed
      // at its boundary exactly as the runtime does.
      mirror.flushWave();
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
        txResults: [{ ok: true, outcome: 'applied', events: [] }],
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
