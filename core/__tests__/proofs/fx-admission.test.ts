/**
 * FX-1/FX-2 admission parity (proofs/fixes.md, decisions D2/D3).
 *
 * Verdict mapping to the Rust twin
 * (rscore/crates/engine/tests/fx_admission.rs) — same accept/reject
 * classification per case, different transport for the same verdict:
 *
 * - local enqueue/admission:
 *   TS   `applyAccountInput({kind:'enqueue'})` throws `AccountTxAdmissionError`
 *        with code `ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE` /
 *        `ACCOUNT_TX_KIND_OUT_OF_PROFILE`, mempool unchanged.
 *   Rust `AccountConsensus::admit_txs` returns
 *        `Err(StateError::PolicyVersionOutOfRange)` /
 *        `Err(StateError::AccountTxKindOutOfProfile(kind))`, mempool unchanged.
 * - incoming counterparty frame:
 *   TS   preflight returns a typed Account input rejection
 *        `ACCOUNT_INPUT_FRAME_TX_POLICY_VERSION_OUT_OF_RANGE` /
 *        `ACCOUNT_INPUT_FRAME_TX_OUT_OF_PROFILE` (message names the kind),
 *        before signature work, replay, or mutation.
 *   Rust `apply_incoming_frame` returns `Rejected` whose reason carries
 *        `ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE` /
 *        `ACCOUNT_TX_KIND_OUT_OF_PROFILE:<kind>` before replay.
 * - boundary accept (policyVersion 0 and MAX): TS admits (ok result) and
 *   Rust admits (Ok, frame hashable) — the golden
 *   `matches_typescript_rebalance_policy_bytes_and_hashes` already pins
 *   MAX hashing identically in both engines.
 */
import { describe, expect, test } from 'bun:test';

import { applyAccountInput } from '../../account/consensus';
import { computeFrameHash } from '../../account/consensus/frame/hash';
import { computeAccountStateRoot } from '../../account/commitment/state-root';
import {
  AccountTxAdmissionError,
  MAX_POLICY_VERSION,
} from '../../account/tx/admission-policy';
import { accountInputFailureMessage, accountInputPeerRejectionCode } from '../../account/consensus/result';
import { createEmptyEnv } from '../../runtime';
import { createAccountConsensusContext } from '../../entity/account/account-consensus-context';
import { makeAccount } from '../helpers/cross-j';
import type { AccountInput, AccountReplica, AccountTx } from '../../types/account';
import { safeStringify } from '../../protocol/serialization';

const rebalancePolicy = (policyVersion: number): AccountTx => ({
  type: 'rebalance_policy',
  data: {
    tokenId: 1,
    policyVersion,
    baseFee: 1n,
    liquidityFeeBps: 375n,
    gasFee: 1n,
  },
});

const setCreditLimit = (amount: bigint): AccountTx => ({
  type: 'set_credit_limit',
  data: { tokenId: 1, amount },
});

const PAYMENT: AccountTx = {
  type: 'direct_payment',
  data: {
    tokenId: 1,
    amount: 100_000_000n,
    route: ['0xrecipient'],
    fromEntityId: '0xsender',
    toEntityId: '0xrecipient',
    deliveryMode: 'direct',
  },
};

// 2^53 = MAX + 1: the first value TypeScript can no longer represent exactly.
const ABOVE_MAX = MAX_POLICY_VERSION + 1;
const TWO_POW_54 = 2 ** 54;
// u64::MAX as a JS double literal is already the distorted value — which is
// precisely the divergence FX-1 exists to reject before hashing.
const U64_MAX_APPROXIMATE = 18_446_744_073_709_551_615;

const OUT_OF_PROFILE_TXS: Array<[string, AccountTx]> = [
  ['lending_fund', {
    type: 'lending_fund',
    data: {
      positionId: 'position-1',
      hubEntityId: '0xhub',
      lenderEntityId: '0xsender',
      tokenId: 1,
      amount: 10n,
      termId: '1d',
      interestBps: 100,
    },
  }],
  ['lending_borrow_request', {
    type: 'lending_borrow_request',
    data: {
      requestId: 'request-1',
      hubEntityId: '0xhub',
      borrowerEntityId: '0xsender',
      tokenId: 1,
      amount: 10n,
      termId: '1d',
      maxInterestBps: 100,
    },
  }],
  ['lending_repay', {
    type: 'lending_repay',
    data: {
      loanId: 'loan-1',
      hubEntityId: '0xhub',
      borrowerEntityId: '0xsender',
      tokenId: 1,
      amount: 10n,
    },
  }],
  ['lending_credit', {
    type: 'lending_credit',
    data: {
      action: 'grant',
      loanId: 'loan-1',
      hubEntityId: '0xhub',
      borrowerEntityId: '0xsender',
      tokenId: 1,
      creditLimit: 10n,
    },
  }],
  ['lending_close_request', {
    type: 'lending_close_request',
    data: { positionId: 'position-1', hubEntityId: '0xhub', lenderEntityId: '0xsender' },
  }],
  ['lending_close_payout', {
    type: 'lending_close_payout',
    data: {
      positionId: 'position-1',
      hubEntityId: '0xhub',
      lenderEntityId: '0xsender',
      tokenId: 1,
      amount: 10n,
    },
  }],
];

const enqueue = async (account: AccountReplica, txs: AccountTx[]) =>
  applyAccountInput(
    createAccountConsensusContext(createEmptyEnv('fx-admission')),
    account,
    { kind: 'enqueue', txs },
  );

describe('FX-1 policyVersion protocol range 0..=MAX_SAFE_INTEGER', () => {
  test.each([
    ['0 (lower bound)', 0],
    ['MAX (upper bound)', MAX_POLICY_VERSION],
  ])('admits policyVersion %s', async (_name, policyVersion) => {
    const account = makeAccount('0xsender', '0xrecipient');
    const result = await enqueue(account, [rebalancePolicy(policyVersion)]);

    expect(result).toMatchObject({ ok: true, admittedAccountTxCount: 1 });
    expect(account.mempool.map(tx => tx.type)).toEqual(['rebalance_policy']);
  });

  test.each([
    ['MAX + 1', ABOVE_MAX],
    ['2^54', TWO_POW_54],
    ['u64::MAX (distorted double)', U64_MAX_APPROXIMATE],
  ])('rejects policyVersion %s before the mempool', async (_name, policyVersion) => {
    const account = makeAccount('0xsender', '0xrecipient');

    await expect(enqueue(account, [rebalancePolicy(policyVersion)]))
      .rejects
      .toThrow('ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE:rebalance_policy');
    expect(account.mempool).toEqual([]);
  });

  test('the typed rejection carries the offending version and range', () => {
    const account = makeAccount('0xsender', '0xrecipient');

    return expect(enqueue(account, [rebalancePolicy(ABOVE_MAX)])).rejects.toMatchObject({
      name: 'AccountTxAdmissionError',
      code: 'ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE',
      txType: 'rebalance_policy',
      policyVersion: ABOVE_MAX,
    });
  });

  test('a rejected batch admits nothing, mirroring Rust whole-batch admission', async () => {
    const account = makeAccount('0xsender', '0xrecipient');

    await expect(enqueue(account, [structuredClone(PAYMENT), rebalancePolicy(TWO_POW_54)]))
      .rejects
      .toThrow('ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE');
    expect(account.mempool).toEqual([]);
  });

  test('an out-of-range value reaching the frame hash is an admission bug, never hashed', () => {
    const account = makeAccount('0xsender', '0xrecipient');
    const frame = {
      height: 1,
      timestamp: 1,
      jHeight: 0,
      accountTxs: [rebalancePolicy(ABOVE_MAX)],
      prevFrameHash: 'genesis',
      accountStateRoot: computeAccountStateRoot(account.state),
      deltas: [],
      stateHash: '',
      byLeft: false,
    };

    expect(() => computeFrameHash(frame)).toThrow(AccountTxAdmissionError);
    expect(() => computeFrameHash(frame))
      .toThrow('ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE:rebalance_policy');
  });
});

describe('FX-3 exact lifecycle retry identity', () => {
  test.each([
    ['set_credit_limit', setCreditLimit(750_000n)],
    ['rebalance_policy', rebalancePolicy(7)],
  ] as const)('deduplicates exact %s across batch, queue and pending frame', async (_kind, lifecycle) => {
    const account = makeAccount('0xsender', '0xrecipient');

    const batch = await enqueue(account, [structuredClone(lifecycle), structuredClone(lifecycle)]);
    expect(batch).toMatchObject({ ok: true, admittedAccountTxCount: 1 });
    expect(account.mempool).toEqual([lifecycle]);

    const queued = await enqueue(account, [structuredClone(lifecycle)]);
    expect(queued).toMatchObject({ ok: true, admittedAccountTxCount: 0 });
    expect(account.mempool).toEqual([lifecycle]);

    account.mempool = [];
    account.pendingFrame = {
      ...account.currentFrame,
      height: 1,
      accountTxs: [structuredClone(lifecycle)],
    };
    const pending = await enqueue(account, [structuredClone(lifecycle)]);
    expect(pending).toMatchObject({ ok: true, admittedAccountTxCount: 0 });
    expect(account.mempool).toEqual([]);
  });

  test('preserves positions for distinct lifecycle payloads and identical payments', async () => {
    const account = makeAccount('0xsender', '0xrecipient');
    const firstCredit = setCreditLimit(750_000n);
    const secondCredit = setCreditLimit(750_001n);

    const result = await enqueue(account, [
      structuredClone(firstCredit),
      structuredClone(PAYMENT),
      structuredClone(firstCredit),
      structuredClone(secondCredit),
      structuredClone(PAYMENT),
    ]);

    expect(result).toMatchObject({ ok: true, admittedAccountTxCount: 4 });
    expect(account.mempool).toEqual([
      firstCredit,
      PAYMENT,
      secondCredit,
      PAYMENT,
    ]);
  });
});

describe('FX-2 lending kinds are out of the production RRS profile', () => {
  test.each(OUT_OF_PROFILE_TXS)('enqueue rejects %s before mempool mutation', async (kind, tx) => {
    const account = makeAccount('0xsender', '0xrecipient');

    await expect(enqueue(account, [structuredClone(tx)]))
      .rejects
      .toThrow(`ACCOUNT_TX_KIND_OUT_OF_PROFILE:${kind}`);
    expect(account.mempool).toEqual([]);
  });

  test('typed rejection names the kind and production profile', async () => {
    const account = makeAccount('0xsender', '0xrecipient');
    const [kind, tx] = OUT_OF_PROFILE_TXS[0]!;

    const rejection = enqueue(account, [structuredClone(tx)]);
    await expect(rejection).rejects.toMatchObject({
      name: 'AccountTxAdmissionError',
      code: 'ACCOUNT_TX_KIND_OUT_OF_PROFILE',
      txType: kind,
    });
    await expect(rejection).rejects.toThrow('pay/HTLC/same-J swap/j-event/rebalance');
  });
});

describe('incoming counterparty frames reject before replay', () => {
  const buildFrameInput = (
    account: AccountReplica,
    tx: AccountTx,
    stateHash: string,
  ): Extract<AccountInput, { kind: 'ack_frame' }> => {
    const env = createEmptyEnv('fx-admission-incoming');
    const frame = {
      height: 1,
      timestamp: env.state.timestamp,
      jHeight: 0,
      accountTxs: [structuredClone(tx)],
      prevFrameHash: 'genesis',
      accountStateRoot: computeAccountStateRoot(account.state),
      deltas: [],
      stateHash,
      byLeft: false,
    };
    return {
      kind: 'ack_frame',
      fromEntityId: account.proofHeader.toEntity,
      toEntityId: account.proofHeader.fromEntity,
      domain: { ...account.state.domain },
      disputeConfig: { ...account.state.disputeConfig },
      watchSeed: account.state.watchSeed,
      proposal: { frame, frameHanko: `0x${'66'.repeat(65)}` },
    };
  };

  test.each(OUT_OF_PROFILE_TXS)(
    'incoming %s is rejected before replay without mutation',
    async (kind, tx) => {
      const account = makeAccount('0xsender', '0xrecipient');
      const input = buildFrameInput(account, tx, '');
      input.proposal.frame.stateHash = computeFrameHash(input.proposal.frame);
      const context = {
        ...createAccountConsensusContext(createEmptyEnv('fx-admission-incoming')),
        verifyHanko: async (_hanko: unknown, _hash: unknown, expectedEntityId: string) => ({
          valid: true,
          entityId: expectedEntityId,
        }),
      } as Parameters<typeof applyAccountInput>[0];
      const before = safeStringify(account);

      const result = await applyAccountInput(context, account, input);

      expect(accountInputPeerRejectionCode(result)).toBe('ACCOUNT_INPUT_FRAME_TX_OUT_OF_PROFILE');
      expect(accountInputFailureMessage(result)).toContain(`ACCOUNT_TX_KIND_OUT_OF_PROFILE:${kind}`);
      expect(account.currentHeight).toBe(0);
      expect(safeStringify(account)).toBe(before);
    },
  );

  test('an out-of-range policyVersion frame is a typed range rejection without mutation', async () => {
    const account = makeAccount('0xsender', '0xrecipient');
    // computeFrameHash refuses this tx by design (FX-1 tripwire), so the peer
    // frame carries an unverifiable stateHash; the preflight rejection fires
    // before any signature or hash work either way.
    const input = buildFrameInput(
      account,
      rebalancePolicy(ABOVE_MAX),
      `0x${'99'.repeat(32)}`,
    );
    const context = {
      ...createAccountConsensusContext(createEmptyEnv('fx-admission-incoming')),
      verifyHanko: async (_hanko: unknown, _hash: unknown, expectedEntityId: string) => ({
        valid: true,
        entityId: expectedEntityId,
      }),
    } as Parameters<typeof applyAccountInput>[0];
    const before = safeStringify(account);

    const result = await applyAccountInput(context, account, input);

    expect(accountInputPeerRejectionCode(result))
      .toBe('ACCOUNT_INPUT_FRAME_TX_POLICY_VERSION_OUT_OF_RANGE');
    expect(result.ok).toBe(false);
    expect(account.currentHeight).toBe(0);
    expect(safeStringify(account)).toBe(before);
  });
});
