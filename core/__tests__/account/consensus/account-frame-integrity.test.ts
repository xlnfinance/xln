import { expect, test } from 'bun:test';

import {
  assertAccountFrameHash,
  canonicalAccountTxForFrameHash,
  computeFrameHash,
} from '../../../account/consensus/frame/hash';
import { decodeAccountFrame } from '../../../account/validation/frame-validation';
import type { AccountFrame, AccountTx } from '../../../types/account';
import { decodeAccountTx } from '../../../account/tx-validation';
import { applyAccountInput } from '../../../account/consensus';
import { accountInputFailureMessage } from '../../../account/consensus/result';
import { computeAccountStateRoot } from '../../../account/commitment/state-root';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { createEmptyEnv } from '../../../runtime';
import { safeStringify } from '../../../protocol/serialization';
import { entity, makeAccount } from '../../helpers/cross-j';

const frame = (): AccountFrame => {
  const value: AccountFrame = {
    height: 1,
    timestamp: 1,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: 'genesis',
    accountStateRoot: `0x${'11'.repeat(32)}`,
    stateHash: '',
  };
  value.stateHash = computeFrameHash(value);
  return value;
};

test('AccountFrame carries one AccountState root and no duplicate financial snapshot', () => {
  const value = frame();
  expect(decodeAccountFrame(value)).toEqual(value);
  expect(() => decodeAccountFrame({ ...value, deltas: [] })).toThrow('AccountFrame.fields');
  expect(() => decodeAccountFrame({ ...value, byLeft: true })).toThrow('AccountFrame.fields');
  expect(() => assertAccountFrameHash(value, 'ACCOUNT_FRAME_HASH_INVALID')).not.toThrow();
});

test('AccountFrame hash binds the canonical state root', () => {
  const value = frame();
  const changed = { ...value, accountStateRoot: `0x${'22'.repeat(32)}` };
  expect(computeFrameHash(changed)).not.toBe(value.stateHash);
});

test('Account frame hashing rejects a malformed J-claim height', () => {
  expect(() => canonicalAccountTxForFrameHash({
    type: 'j_event_claim',
    data: {
      jHeight: Number.NaN,
      jBlockHash: `0x${'22'.repeat(32)}`,
      events: [],
      leftProof: {},
      rightProof: {},
    },
  })).toThrow('ACCOUNT_FRAME_J_EVENT_CLAIM_HEIGHT_INVALID');
});

const settledEvent = (left: string, right: string) => ({
  blockNumber: 5,
  blockHash: `0x${'cc'.repeat(32)}`,
  transactionHash: `0x${'dd'.repeat(32)}`,
  logIndex: 0,
  type: 'AccountSettled' as const,
  data: {
    leftEntity: left, rightEntity: right, tokenId: 1, leftReserve: 0n, rightReserve: 0n,
    collateral: 1n, ondelta: 0n, nonce: 1,
  },
});

test('peer j_event_claim shapes the accumulator would throw on fail at the decoder', () => {
  const event = settledEvent(entity('11'), entity('22'));
  const claim = (data: Record<string, unknown>) => ({
    type: 'j_event_claim',
    data: { jHeight: 5, jBlockHash: `0x${'cc'.repeat(32)}`, events: [event], ...data },
  });
  expect(decodeAccountTx(claim({}), 'PEER')).toBeDefined();
  expect(() => decodeAccountTx(claim({ events: [] }), 'PEER')).toThrow('PEER_DATA_EVENTS');
  expect(() => decodeAccountTx(claim({ events: [event, event] }), 'PEER')).toThrow('PEER_DATA_EVENT_DUPLICATE_1');
  expect(() => decodeAccountTx(claim({ jHeight: 0 }), 'PEER')).toThrow('PEER_DATA_JHEIGHT');
  expect(() => decodeAccountTx(claim({ jBlockHash: '0x1234' }), 'PEER')).toThrow('PEER_DATA_JBLOCKHASH');
});

test('a peer j_event_claim with a forged witness is a typed frame rejection, not a halt', async () => {
  // Empty accumulators: the canonical witness has no nodes. The forged one
  // carries a leaf, which verifyAccountJClaimProof rejected by throwing
  // ACCOUNT_J_CLAIM_PROOF_TRAILING_NODES inside the receiver's replay.
  const LEFT = entity('11');
  const RIGHT = entity('22');
  const account = makeAccount(LEFT, RIGHT);
  const forged = {
    version: 1,
    nodes: [{ version: 1, type: 'leaf', key: `0x${'ab'.repeat(32)}`, record: {
      version: 1, accountKey: `0x${'ab'.repeat(32)}`, side: 'left', jHeight: 5,
      jBlockHash: `0x${'cc'.repeat(32)}`, eventsHash: `0x${'ee'.repeat(32)}`,
    } }],
  };
  const value: AccountFrame = {
    height: 1,
    timestamp: 1_000,
    jHeight: 0,
    accountTxs: [{
      type: 'j_event_claim',
      data: {
        jHeight: 5,
        jBlockHash: `0x${'cc'.repeat(32)}`,
        events: [settledEvent(LEFT, RIGHT)],
        leftProof: forged,
        rightProof: { version: 1, nodes: [] },
      },
    } as AccountTx],
    prevFrameHash: 'genesis',
    accountStateRoot: computeAccountStateRoot(account.state),
    stateHash: '',
  };
  value.stateHash = computeFrameHash(value);
  const context = {
    ...createAccountConsensusContext(createEmptyEnv('peer-forged-j-claim-witness')),
    verifyHanko: async (_hanko: string, _hash: string, expectedEntityId: string) =>
      ({ valid: true, entityId: expectedEntityId }),
  };
  const before = safeStringify(account);
  const result = await applyAccountInput(context, account, {
    kind: 'ack_frame',
    fromEntityId: RIGHT,
    toEntityId: LEFT,
    domain: { ...account.state.domain },
    disputeConfig: { ...account.state.disputeConfig },
    watchSeed: account.state.watchSeed,
    proposal: { frame: value, frameHanko: `0x${'66'.repeat(65)}` },
  });
  expect(result.ok).toBe(false);
  expect(accountInputFailureMessage(result)).toContain('ACCOUNT_INPUT_FRAME_J_CLAIM_WITNESS_MISMATCH');
  expect(safeStringify(account)).toBe(before);
});
