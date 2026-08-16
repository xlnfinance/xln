import { describe, expect, test } from 'bun:test';

import { addReplica, entity, makeJurisdiction, makeState, addr } from '../../helpers/cross-j';
import { createEmptyEnv } from '../../../runtime';
import { getReliableOutputIdentity } from '../../../runtime/delivery/identity';
import { isReliableIdentityTerminalInPostState } from '../../../runtime/reliable/reliable-authority';
import type { DeliverableEntityInput } from '../../../runtime/types';

const owner = entity('b1');
const peer = entity('d1');
const signer = addr('b2');

const frameAck = (height: number, frameHash: string): DeliverableEntityInput => ({
  entityId: owner,
  signerId: signer,
  entityTxs: [{
    type: 'accountInput',
    data: {
      kind: 'frame_ack',
      fromEntityId: peer,
      toEntityId: owner,
      ack: { height, frameHash, frameHanko: '0xack-hanko' },
      proposal: {
        frame: {
          height: height + 1,
          timestamp: height + 1,
          jHeight: height + 1,
          accountTxs: [],
          prevFrameHash: frameHash,
          accountStateRoot: `0xaccount-root-${height + 1}`,
          stateHash: `0xproposal-${height + 1}`,
          deltas: [],
        },
        frameHanko: '0xproposal-hanko',
      },
    },
  } as never],
});

const plainAck = (height: number, frameHash: string): DeliverableEntityInput => ({
  entityId: owner,
  signerId: signer,
  entityTxs: [{
    type: 'accountInput',
    data: {
      kind: 'ack',
      fromEntityId: peer,
      toEntityId: owner,
      ack: { height, frameHash, frameHanko: '0xack-hanko' },
    },
  } as never],
});

const envWithAccount = (height: number, prevFrameHash: string, stateHash: string) => {
  const env = createEmptyEnv('account-ack-terminal');
  const state = makeState(owner, signer, makeJurisdiction('ack-terminal', 31337, 'a1', 'b2'), peer);
  addReplica(env, state, signer);
  const replica = env.state.eReplicas.get(`${owner}:${signer}`);
  if (!replica) throw new Error('TEST_ACK_TERMINAL_REPLICA_MISSING');
  const account = replica.state.accounts.get(peer);
  if (!account) throw new Error('TEST_ACK_TERMINAL_ACCOUNT_MISSING');
  replica.state = {
    ...replica.state,
    accounts: replica.state.accounts.updated(peer, {
      ...account,
      currentHeight: height,
      currentFrame: { ...account.currentFrame, height, prevFrameHash, stateHash },
    }),
  };
  return env;
};

describe('reliable account ACK terminal proof', () => {
  test('frame-ack is terminal only at exact H+1 with prevFrameHash', () => {
    const identity = getReliableOutputIdentity(frameAck(5, '0xframe-5'));
    if (!identity) throw new Error('TEST_FRAME_ACK_IDENTITY_MISSING');
    expect(isReliableIdentityTerminalInPostState(
      envWithAccount(7, '0xframe-5', '0xstate-7'),
      identity,
    )).toBe(false);
    expect(isReliableIdentityTerminalInPostState(
      envWithAccount(6, '0xother-frame', '0xstate-6'),
      identity,
    )).toBe(false);
    expect(isReliableIdentityTerminalInPostState(
      envWithAccount(6, '0xframe-5', '0xstate-6'),
      identity,
    )).toBe(true);
  });

  test('plain ACK is terminal only at exact height with stateHash', () => {
    const identity = getReliableOutputIdentity(plainAck(5, '0xframe-5'));
    if (!identity) throw new Error('TEST_PLAIN_ACK_IDENTITY_MISSING');
    expect(isReliableIdentityTerminalInPostState(
      envWithAccount(6, '0xframe-5', '0xframe-5'),
      identity,
    )).toBe(false);
    expect(isReliableIdentityTerminalInPostState(
      envWithAccount(5, '0xprev', '0xframe-5'),
      identity,
    )).toBe(true);
  });
});
