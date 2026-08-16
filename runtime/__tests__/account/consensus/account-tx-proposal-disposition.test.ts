import { describe, expect, test } from 'bun:test';

import { validateProposalTransactions } from '../../../account/consensus/proposal/transactions';
import type { AccountConsensusContext } from '../../../account/consensus/context';
import { applyAccountTx } from '../../../account/tx/apply';
import { ACCOUNT_TX_REJECTION_CODES } from '../../../account/tx/apply-types';
import { hashHtlcSecret } from '../../../protocol/htlc/utils';
import { TOKENS } from '../../../config/constants';
import type { AccountTx } from '../../../types/account';
import { entity, makeAccount } from '../../helpers/cross-j';

const LEFT = entity('11');
const RIGHT = entity('22');
const HEX32 = (byte: string): string => `0x${byte.repeat(32)}`;

const consensusContext = (): AccountConsensusContext => ({
  runtimeTimestamp: 1_000,
  quietLogs: true,
  emitRuntimeEvents: false,
  jReplicas: new Map(),
  jClaimNodeStore: new Map(),
  verifyHanko: async () => ({ valid: true, entityId: null }),
  resolveSettlementBoardAuthority: async () => undefined,
});

const payment = (): Extract<AccountTx, { type: 'direct_payment' }> => ({
  type: 'direct_payment',
  data: {
    tokenId: 1,
    amount: 7n,
    route: [RIGHT],
    fromEntityId: LEFT,
    toEntityId: RIGHT,
    deliveryMode: 'direct',
  },
});

describe('Account tx proposal disposition', () => {
  test('signed settlement freeze defers a payment instead of removing it', async () => {
    const account = makeAccount(LEFT, RIGHT);
    const upserted = await applyAccountTx(account, {
      type: 'settle_transition',
      data: {
        kind: 'upsert',
        revision: 1,
        ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
        executorIsLeft: false,
      },
    }, true, 1_000);
    expect(upserted.ok).toBe(true);
    account.state.settlementWorkspace!.leftHanko = '0x1234';
    const tx = payment();
    const validation = await validateProposalTransactions({
      consensusContext: consensusContext(),
      account,
      proposalWindow: [tx],
      frameTimestamp: 2_000,
      frameJHeight: 0,
      jClaimNodeStore: new Map(),
    });
    expect(validation.validTxs).toEqual([]);
    expect(validation.txsToRemove).toEqual([]);
    expect(validation.deferredTxCount).toBe(1);
    expect(validation.events.some((event) => event.includes('SETTLEMENT_SIGNED_ACCOUNT_FROZEN:direct_payment'))).toBe(true);
    expect(account.state.deltas.get(1)?.offdelta).toBe(0n);
  });

  test('invalid add_delta is removed with a typed delta rejection', async () => {
    const account = makeAccount(LEFT, RIGHT);
    const tx: AccountTx = {
      type: 'add_delta',
      data: { tokenId: TOKENS.MAX_TOKEN_ID + 1 },
    };
    const validation = await validateProposalTransactions({
      consensusContext: consensusContext(),
      account,
      proposalWindow: [tx],
      frameTimestamp: 1_000,
      frameJHeight: 0,
      jClaimNodeStore: new Map(),
    });
    expect(validation.validTxs).toEqual([]);
    expect(validation.txsToRemove).toEqual([tx]);
    expect(validation.deferredTxCount).toBe(0);
    expect(ACCOUNT_TX_REJECTION_CODES.deltaTokenInvalid).toBe('ACCOUNT_DELTA_TOKEN_INVALID');
  });

  test('matcher-generated swap resolve cannot be silently removed', async () => {
    const account = makeAccount(LEFT, RIGHT);
    await expect(validateProposalTransactions({
      consensusContext: consensusContext(),
      account,
      proposalWindow: [{
        type: 'swap_resolve',
        data: { offerId: 'missing-matcher-offer', fillRatio: 1, cancelRemainder: true },
      }],
      frameTimestamp: 1_000,
      frameJHeight: 0,
      jClaimNodeStore: new Map(),
    })).rejects.toThrow('SWAP_RESOLVE_PROPOSAL_FAILED');
  });

  test('payment then HTLC lock/secret resolve on one Account replica', async () => {
    const account = makeAccount(LEFT, RIGHT);
    const paid = await applyAccountTx(account, payment(), true, 1_000, 0);
    expect(paid.ok).toBe(true);
    if (!paid.ok) throw new Error('ACCOUNT_TX_L2_PAYMENT');
    expect(paid.outcome).toBe('applied');
    expect(account.state.deltas.get(1)?.offdelta).toBe(-7n);

    const secret = HEX32('44');
    const lockId = 'lock-l2-secret';
    const locked = await applyAccountTx(account, {
      type: 'htlc_lock',
      data: {
        lockId,
        hashlock: hashHtlcSecret(secret),
        timelock: 60_000n,
        revealBeforeHeight: 10,
        amount: 3n,
        tokenId: 1,
      },
    }, true, 1_001, 0);
    expect(locked.ok).toBe(true);
    expect(account.state.locks.has(lockId)).toBe(true);

    const revealed = await applyAccountTx(account, {
      type: 'htlc_resolve',
      data: { lockId, outcome: 'secret', secret },
    }, false, 1_002, 1);
    expect(revealed.ok).toBe(true);
    if (!revealed.ok || revealed.outcome !== 'htlc_secret') {
      throw new Error('ACCOUNT_TX_L2_HTLC_SECRET');
    }
    expect(revealed.secret).toBe(secret);
    expect(account.state.locks.has(lockId)).toBe(false);
    expect(account.state.deltas.get(1)?.leftHold).toBe(0n);
    expect(account.state.deltas.get(1)?.offdelta).toBe(-10n);
  });
});
