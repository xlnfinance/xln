import { expect, test } from 'bun:test';
import { makeAccount, entity } from '../../helpers/cross-j';
import { applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import { computeAccountStateRoot } from '../../../account/commitment/state-root';
import {
  effectiveRebalanceTerms,
  worseRebalanceTerms,
  DEFAULT_TERM_NOTICE_SECONDS,
} from '../../../account/config/term-notice';
import { buildHubConfig, buildHubRebalancePolicyTx } from '../../../entity/tx/handlers/account/lifecycle/admin';
import { forkAccountReplicaShell } from '../../../account/state/account-replica-shell';
import { buildProposalFrame } from '../../../account/consensus/proposal/frame';
import { commitAccountFrameTransition } from '../../../account/consensus/frame/commit-transition';
import { createAccountJClaimSession } from '../../../account/j-claims/j-claim-session';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { createEmptyEnv } from '../../../runtime';
import { encodeBuffer, decodeBuffer } from '../../../storage/codec/codec';
import { hydrateAccountDocFromStorage, projectPortableAccountDoc } from '../../../storage/read/projections';
import { validateStorageAccountDocValue } from '../../../storage/schema/schema-state-docs';
import type { AccountReplica, AccountTx } from '../../../types/account';
import { asTokenId } from '../../../account/tx/units';

const left = entity('11');
const right = entity('22');
const policy = (version: number, baseFee: bigint, noticePeriodSeconds = 2): AccountTx => ({
  type: 'rebalance_policy',
  data: { tokenId: 1, policyVersion: version, baseFee, liquidityFeeBps: 10n, gasFee: 1n, noticePeriodSeconds },
});
const apply = (account: AccountReplica, tx: AccountTx, time: number, byLeft = true) =>
  applyAccountTxToMutableReplica(account, tx, byLeft, time, 0);
const snapshot = (account: AccountReplica) => account.state.rebalanceFeePolicies!.get(1)!.left!;
const request = (version: number, fee: bigint): AccountTx => ({
  type: 'request_collateral',
  data: { tokenId: 1, policyVersion: version, amount: 10_000n, feeAmount: fee },
});

test('any higher fee is adverse; reductions and equal terms are not', () => {
  const old = { policyVersion: 1, baseFee: 10n, gasFee: 3n, liquidityFeeBps: 20n, updatedAt: 1 };
  for (const field of ['baseFee', 'gasFee', 'liquidityFeeBps'] as const) {
    expect(worseRebalanceTerms(old, { ...old, [field]: old[field] + 1n })).toBe(true);
    expect(worseRebalanceTerms(old, { ...old, [field]: old[field] - 1n })).toBe(false);
  }
  expect(worseRebalanceTerms(old, old)).toBe(false);
  expect(worseRebalanceTerms(old, { ...old, baseFee: 1n, gasFee: 4n })).toBe(true);
});

test('hub config commits 30 days by default and explicit scenario periods', () => {
  const { config } = buildHubConfig(undefined, {});
  expect(config.termNoticePeriodSeconds).toBe(30 * 86400);
  expect(buildHubRebalancePolicyTx(config, 1).data.noticePeriodSeconds).toBe(DEFAULT_TERM_NOTICE_SECONDS);
  expect(buildHubConfig(config, { termNoticePeriodSeconds: 2 }).config.termNoticePeriodSeconds).toBe(2);
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    expect(() => buildHubConfig(config, { termNoticePeriodSeconds: value })).toThrow('HUB_TERM_NOTICE_INVALID');
  }
});

test.each([
  [1, 100_000n], // USDC: $0.10 at $1, six decimals.
  [2, 40_000_000_000_000n], // WETH: $0.10 at $2,500, eighteen decimals.
  [4, 833_333n], // TRX: floor($0.10 at $0.12), six decimals.
] as const)('USD-derived policy for token %s preserves the committed notice', async (id, baseFee) => {
  const tokenId = asTokenId(id);
  const account = makeAccount(left, right);
  expect((await apply(account, { type: 'add_delta', data: { tokenId } }, 1000)).ok).toBe(true);
  const { config } = buildHubConfig(undefined, { termNoticePeriodSeconds: 2 });
  const initial = buildHubRebalancePolicyTx(config, tokenId);
  expect(initial.data.baseFee).toBe(baseFee);
  expect((await apply(account, initial, 1000)).ok).toBe(true);
  const increased = buildHubConfig(config, { policyVersion: 2, rebalanceLiquidityFeeBps: 5n }).config;
  expect((await apply(account, buildHubRebalancePolicyTx(increased, tokenId), 2000)).ok).toBe(true);
  const next = account.state.rebalanceFeePolicies!.get(tokenId)!.left!;
  expect(next.effectiveAt).toBe(34000);
  expect(effectiveRebalanceTerms(next, 33999)).toMatchObject({ baseFee, liquidityFeeBps: 1n, policyVersion: 1 });
  expect(effectiveRebalanceTerms(next, 34000)).toMatchObject({ baseFee, liquidityFeeBps: 5n, policyVersion: 2 });
});

test('existing customers pay old fees until the exact committed deadline; new accounts get current terms', async () => {
  const account = makeAccount(left, right);
  expect((await apply(account, policy(1, 10n), 1000)).ok).toBe(true);
  expect((await apply(account, policy(2, 30n), 2000)).ok).toBe(true);
  expect(snapshot(account).effectiveAt).toBe(34000);
  for (const [time, version, fee] of [
    [33999, 1, 21n],
    [34000, 2, 41n],
    [34001, 2, 41n],
  ] as const) {
    const copy = forkAccountReplicaShell(account);
    expect((await apply(copy, request(version, fee), time, false)).ok).toBe(true);
    const wrong = forkAccountReplicaShell(account);
    const before = computeAccountStateRoot(wrong.state);
    expect((await apply(wrong, request(version === 1 ? 2 : 1, fee), time, false)).ok).toBe(false);
    expect(computeAccountStateRoot(wrong.state)).toBe(before);
  }
  const fresh = makeAccount(left, right);
  expect((await apply(fresh, policy(2, 30n), 2000)).ok).toBe(true);
  expect(effectiveRebalanceTerms(snapshot(fresh), 2000).policyVersion).toBe(2);
});

test('improvements are immediate; retries, side authority and replacement notices are safe', async () => {
  const account = makeAccount(left, right);
  await apply(account, policy(1, 10n), 1000);
  await apply(account, policy(2, 30n), 2000);
  const before = computeAccountStateRoot(account.state);
  expect((await apply(account, policy(2, 30n), 2500)).ok).toBe(true);
  expect(computeAccountStateRoot(account.state)).toBe(before);
  expect((await apply(account, policy(3, 40n), 2500)).ok).toBe(true);
  expect(snapshot(account).effectiveAt).toBe(34500);
  expect(effectiveRebalanceTerms(snapshot(account), 34000).baseFee).toBe(10n);
  expect((await apply(account, policy(4, 5n), 2500)).ok).toBe(true);
  expect(snapshot(account).previous).toBeUndefined();
  expect(snapshot(account).effectiveAt).toBe(2500);
  expect((await apply(account, policy(1, 99n), 2500, false)).ok).toBe(true);
  expect(snapshot(account).baseFee).toBe(5n);
});

test('shortening the notice period itself waits out the previously committed period', async () => {
  const account = makeAccount(left, right);
  await apply(account, policy(1, 10n, 30), 1000);
  await apply(account, policy(2, 10n, 1), 2000);
  expect(snapshot(account).effectiveAt).toBe(62000);
  expect(effectiveRebalanceTerms(snapshot(account), 61999).noticePeriodSeconds).toBe(30);
  expect(effectiveRebalanceTerms(snapshot(account), 62000).noticePeriodSeconds).toBe(1);
  const attack = forkAccountReplicaShell(account);
  expect((await apply(attack, policy(3, 20n, 1), 61999)).ok).toBe(true);
  expect(snapshot(attack).effectiveAt).toBe(121999);
  expect(effectiveRebalanceTerms(snapshot(attack), 62000).noticePeriodSeconds).toBe(30);
  expect((await apply(account, policy(3, 20n, 1), 62000)).ok).toBe(true);
  expect(snapshot(account).effectiveAt).toBe(93000);
});

test('checkpoint recovery preserves the pending deadline and rejects obsolete policy state', async () => {
  const account = makeAccount(left, right);
  await apply(account, policy(1, 10n), 1000);
  await apply(account, policy(2, 30n), 2000);
  const restored = hydrateAccountDocFromStorage(
    validateStorageAccountDocValue(decodeBuffer(encodeBuffer(projectPortableAccountDoc(account)))),
  );
  expect(computeAccountStateRoot(restored.state)).toBe(computeAccountStateRoot(account.state));
  expect((await apply(restored, request(2, 41n), 33999, false)).ok).toBe(false);
  expect((await apply(restored, request(1, 21n), 33999, false)).ok).toBe(true);
  const portable = projectPortableAccountDoc(account);
  const decoded = decodeBuffer(encodeBuffer(portable));
  const parsed = validateStorageAccountDocValue(decoded);
  const old = parsed.state.rebalanceFeePolicies!.get(1)!.left!;
  old.effectiveAt = 3999;
  expect(() => validateStorageAccountDocValue(parsed)).toThrow('notice is too short');
  old.effectiveAt = 34000;
  Reflect.deleteProperty(old, 'noticePeriodSeconds');
  expect(() => validateStorageAccountDocValue(parsed)).toThrow('testnet chain reset required');
});

test('ordered Account frames replay with identical roots/effects across a restart during notice', async () => {
  const context = createAccountConsensusContext(createEmptyEnv('term-notice-replay'));
  const account = makeAccount(left, right);
  let replay = makeAccount(left, right);
  const rows = [
    [1000, policy(1, 10n)],
    [2000, policy(2, 30n)],
    [33999, policy(2, 30n)],
    [34000, policy(3, 31n)],
  ] as const;
  for (const [time, tx] of rows) {
    const candidate = forkAccountReplicaShell(account);
    expect((await apply(candidate, tx, time)).ok).toBe(true);
    const built = await buildProposalFrame(account, candidate, [tx], time, 0, [], () => {});
    if (!built.ok) throw new Error('notice frame build rejected');
    const results = [];
    for (const target of [account, replay]) {
      results.push(
        await commitAccountFrameTransition({
          context,
          account: target,
          frame: built.frame,
          proposerIsLeft: true,
          jClaimSession: createAccountJClaimSession(new Map()),
          role: 'proposer/commit',
        }),
      );
      target.currentFrame = built.frame;
      target.currentHeight = built.frame.height;
    }
    expect(results[0]).toEqual(results[1]);
    expect(computeAccountStateRoot(account.state)).toBe(computeAccountStateRoot(replay.state));
    if (time === 2000) {
      replay = hydrateAccountDocFromStorage(
        validateStorageAccountDocValue(decodeBuffer(encodeBuffer(projectPortableAccountDoc(replay)))),
      );
      expect(snapshot(replay).previous?.baseFee).toBe(10n);
      expect(snapshot(replay).effectiveAt).toBe(34000);
    }
  }
});
