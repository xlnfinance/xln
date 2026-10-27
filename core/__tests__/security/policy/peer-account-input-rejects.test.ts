/**
 * A remote peer must never halt our Runtime through Account input.
 *
 * Signer/authority: every input below is an authenticated peer frame (the
 * Hanko verifier accepts it), so the only defence left is the Account
 * transition itself. Old state: an empty bilateral Account at height 0. New
 * state on rejection: byte-identical. Counterexample before the fix: each
 * frame threw a plain Error/TypeError or haltRuntimeFailure out of
 * applyAccountInput, which the Entity reducer treats as a Runtime halt.
 */
import { describe, expect, test } from 'bun:test';

import { applyAccountInput } from '../../../account/consensus';
import { computeFrameHash } from '../../../account/consensus/frame/hash';
import { computeAccountStateRoot } from '../../../account/commitment/state-root';
import { accountInputFailureMessage, accountInputPeerRejectionCode } from '../../../account/consensus/result';
import { createDefaultDelta } from '../../../account/state/delta';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { inboundArrivals } from '../../../entity/account/inbound-arrivals';
import { createDisputeProofHashWithNonce } from '../../../protocol/dispute/proof-builder';
import { UINT256_MAX } from '../../../protocol/boundary/integer-ranges';
import { safeStringify } from '../../../protocol/serialization';
import { createEmptyEnv } from '../../../runtime';
import type { AccountInput, AccountReplica, AccountTx } from '../../../types/account';
import type { EntityTx } from '../../../types/entity-tx';
import { entity, jref, makeAccount, makeJurisdiction, putTestAccountDelta, putTestAccountPull } from '../../helpers/cross-j';

const SELF = entity('11');
const PEER = entity('22');
const SOURCE_J = jref(makeJurisdiction('source', 31_337, 'dd', 'ee'));
const TARGET_J = jref(makeJurisdiction('target', 31_338, 'd1', 'e1'));

const trustingContext = (label: string): Parameters<typeof applyAccountInput>[0] => ({
  ...createAccountConsensusContext(createEmptyEnv(label)),
  verifyHanko: async (_hanko: unknown, _hash: unknown, expectedEntityId: string) => ({
    valid: true,
    entityId: expectedEntityId,
  }),
}) as Parameters<typeof applyAccountInput>[0];

/** The right-side peer proposes frame 1 carrying exactly one AccountTx. */
const peerFrame = (account: AccountReplica, tx: AccountTx): Extract<AccountInput, { kind: 'ack_frame' }> => {
  const frame = {
    height: 1,
    timestamp: 1,
    jHeight: 0,
    accountTxs: [structuredClone(tx)],
    prevFrameHash: 'genesis',
    accountStateRoot: computeAccountStateRoot(account.state),
    deltas: [],
    stateHash: '',
    byLeft: false,
  };
  frame.stateHash = computeFrameHash(frame);
  return {
    kind: 'ack_frame',
    fromEntityId: PEER,
    toEntityId: SELF,
    domain: { ...account.state.domain },
    disputeConfig: { ...account.state.disputeConfig },
    watchSeed: account.state.watchSeed,
    proposal: { frame, frameHanko: `0x${'66'.repeat(65)}` },
  };
};

const expectTypedFrameRejection = async (
  account: AccountReplica,
  tx: AccountTx,
  reason: string,
): Promise<void> => {
  const before = safeStringify(account);
  const result = await applyAccountInput(trustingContext(`peer-reject-${tx.type}`), account, peerFrame(account, tx));
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('EXPECTED_REJECTION');
  // A Hanko-signed frame that fails replay is retained as dispute evidence;
  // either way the outcome is a typed Account verdict the Runtime survives.
  expect(['rejected', 'dispute']).toContain(result.disposition);
  expect(accountInputFailureMessage(result)).toContain(`Frame application failed: ${reason}`);
  expect(account.currentHeight).toBe(0);
  expect(safeStringify(account)).toBe(before);
};

describe('peer Account input is a typed reject, never a Runtime halt', () => {
  test('lending: a non-canonical intent id and a forged role reject the frame', async () => {
    const forgedRole: AccountTx = {
      type: 'lending_fund',
      data: {
        positionId: 'lend-1111111111111111', hubEntityId: SELF, lenderEntityId: SELF,
        tokenId: 1, amount: 10n, termId: '1d', interestBps: 100,
      },
    };
    await expectTypedFrameRejection(makeAccount(SELF, PEER), forgedRole, 'LENDING_LENDER_NOT_PROPOSER');
    const badIntent: AccountTx = {
      type: 'lending_close_request',
      data: { positionId: 'position-1', hubEntityId: SELF, lenderEntityId: PEER },
    };
    await expectTypedFrameRejection(makeAccount(SELF, PEER), badIntent, 'LENDING_INTENT_ID_INVALID:position-1');
  });

  test('lending: token 0 is rejected before it becomes a covenant', async () => {
    const account = makeAccount(SELF, PEER);
    // The peer (RIGHT) owns collateral on a token-0 row, so funding would
    // otherwise pass the balance check and reach assertLendingCovenant.
    const row = createDefaultDelta(0);
    row.collateral = 1_000n;
    putTestAccountDelta(account, row);
    const tx: AccountTx = {
      type: 'lending_fund',
      data: {
        positionId: 'lend-1111111111111111', hubEntityId: SELF, lenderEntityId: PEER,
        tokenId: 0, amount: 10n, termId: '1d', interestBps: 100,
      },
    };
    await expectTypedFrameRejection(account, tx, 'LENDING_TOKEN_INVALID:0');
  });

  test('rebalance_policy: a fee above uint256 rejects the frame instead of overflowing the leaf', async () => {
    for (const [baseFee, gasFee] of [[UINT256_MAX + 1n, 1n], [1n, 2n ** 80_000n]] as const) {
      const tx: AccountTx = {
        type: 'rebalance_policy',
        data: { tokenId: 1, policyVersion: 1, baseFee, liquidityFeeBps: 375n, gasFee },
      };
      await expectTypedFrameRejection(makeAccount(SELF, PEER), tx, 'rebalance_policy: invalid fee terms for token 1');
    }
  });

  const crossOffer = (route: Record<string, unknown>): AccountTx => ({
    type: 'swap_offer',
    data: {
      offerId: 'cross-offer-1', giveTokenId: 1, giveTokenDecimals: 18, giveAmount: 10n ** 18n,
      wantTokenId: 2, wantTokenDecimals: 18, wantAmount: 10n ** 18n, maxFee: 0n, minNetReceive: 10n ** 18n,
      crossJurisdiction: route as never,
    },
  });

  const pull = { pullId: `0x${'aa'.repeat(32)}`, tokenId: 1, amount: 10n ** 18n, signedAmount: 10n ** 18n,
    fullHash: `0x${'bb'.repeat(32)}`, partialRoot: `0x${'cc'.repeat(32)}` };
  const validRoute = (): Record<string, unknown> => ({
    orderId: 'order-1', makerEntityId: PEER, hubEntityId: SELF,
    source: { jurisdiction: SOURCE_J, entityId: PEER, counterpartyEntityId: SELF, tokenId: 1, amount: 10n ** 18n },
    target: { jurisdiction: TARGET_J, entityId: PEER, counterpartyEntityId: SELF, tokenId: 2, amount: 10n ** 18n },
    sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    status: 'resting', createdAt: 1, updatedAt: 1,
    sourcePull: { ...pull }, targetPull: { ...pull, pullId: `0x${'dd'.repeat(32)}`, tokenId: 2 },
  });

  test('swap_offer: a record-only cross-j route without makerEntityId is a shape reject, not a TypeError', async () => {
    const { makerEntityId: _omitted, ...route } = validRoute();
    await expectTypedFrameRejection(makeAccount(SELF, PEER), crossOffer(route), 'CROSS_J_SWAP_OFFER_ROUTE_INVALID:CROSS_J_SWAP_OFFER_ROUTE_FIELDS:missing=makerEntityId');
  });

  test('swap_offer: a claimed route hash that is not canonical rejects instead of haltRuntimeFailure', async () => {
    const account = makeAccount(SELF, PEER);
    putTestAccountDelta(account, createDefaultDelta(2));
    putTestAccountPull(account, pull.pullId, {
      ...pull,
      crossJurisdiction: { leg: 'source', orderId: 'order-1', routeHash: `0x${'ee'.repeat(32)}` },
    } as never);
    const route = { ...validRoute(), routeHash: `0x${'ee'.repeat(32)}` };
    await expectTypedFrameRejection(account, crossOffer(route), 'CROSS_J_SWAP_OFFER_ROUTE_INVALID:CROSS_J_ROUTE_HASH_MISMATCH');
  });

  test('dispute Hanko: a standalone witness that exhausts the shared nonce is rejected before storage', async () => {
    const account = makeAccount(SELF, PEER);
    const body = `0x${'11'.repeat(32)}`;
    account.currentDisputeProofBodyHash = body;
    const proofNonce = Number.MAX_SAFE_INTEGER - 1;
    const before = safeStringify(account);
    const result = await applyAccountInput(trustingContext('peer-exhausted-dispute'), account, {
      kind: 'dispute',
      fromEntityId: PEER,
      toEntityId: SELF,
      domain: account.state.domain,
      disputeConfig: account.state.disputeConfig,
      watchSeed: account.state.watchSeed,
      disputeHanko: {
        hanko: '0x01',
        hash: createDisputeProofHashWithNonce(account.state, body, account.state.domain, proofNonce, false),
        proofBodyHash: body,
        proofNonce,
        proposerIsLeft: false,
      },
    });
    expect(accountInputPeerRejectionCode(result)).toBe('ACCOUNT_INPUT_DISPUTE_HANKO_INVALID');
    expect(accountInputFailureMessage(result)).toContain('SETTLEMENT_NONCE_EXHAUSTED');
    expect(account.counterpartyDisputeProofNonce).toBeUndefined();
    expect(safeStringify(account)).toBe(before);
  });

  test('cutover path: board_hanko_refresh and dispute arrivals reach the Account worker', () => {
    const refresh = {
      kind: 'board_hanko_refresh',
      fromEntityId: PEER,
      toEntityId: SELF,
      boardHankoRefresh: { height: 3, frameHash: `0x${'44'.repeat(32)}`, boardEpoch: 2 },
    } as unknown as AccountInput;
    const dispute = { kind: 'dispute', fromEntityId: PEER, toEntityId: SELF } as unknown as AccountInput;
    const txs = [refresh, dispute].map(data => ({ type: 'accountInput', data }) as EntityTx);
    expect(inboundArrivals(txs).map(arrival => [arrival.accountId, arrival.input.kind])).toEqual([
      [PEER, 'board_hanko_refresh'],
      [PEER, 'dispute'],
    ]);
  });
});
