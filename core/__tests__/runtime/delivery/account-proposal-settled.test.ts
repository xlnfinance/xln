import { describe, expect, test } from 'bun:test';

import { accountProposalSettledBySender } from '../../../runtime/delivery/identity';
import { pruneSettledOutputs } from '../../../runtime/delivery/pending';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { entity, makeAccount } from '../../helpers/cross-j';
import type { AccountFrame, AccountReplica } from '../../../types/account';
import type { RuntimeReplica, RoutedEntityInput } from '../../../runtime/types';

const FROM = entity('11');
const TO = entity('22');

const accountFrame = (height: number, stateHash: string): AccountFrame => ({
  height,
  timestamp: 1,
  jHeight: 0,
  accountTxs: [],
  prevFrameHash: `0x${'ab'.repeat(32)}`,
  accountStateRoot: `0x${'00'.repeat(32)}`,
  deltas: [],
  stateHash,
  byLeft: true,
});

const withAccount = (account: AccountReplica): RuntimeReplica => ({
  state: {
    eReplicas: new Map([[`${account.proofHeader.fromEntity}:s`, {
      entityId: account.proofHeader.fromEntity,
      signerId: 's',
      state: {
        accounts: PersistentEntityAccountMap.fromMap(
          new Map([[account.proofHeader.toEntity, account]]),
          account.proofHeader.fromEntity,
          computeEntityAccountValueHash,
        ),
      },
    }]]),
  },
} as unknown as RuntimeReplica);

const routedAccountInput = (
  account: AccountReplica,
  data: RoutedEntityInput['entityTxs'] extends (infer Tx)[] | undefined
    ? Tx extends { type: 'accountInput'; data: infer Data } ? Data : never
    : never,
): RoutedEntityInput => ({
  entityId: account.proofHeader.toEntity,
  signerId: 's',
  entityTxs: [{ type: 'accountInput', data }],
});

describe('account proposal outbox settlement', () => {
  test('keeps a bundled ack_frame after the successor pending frame is gone', () => {
    const live = makeAccount(FROM, TO);
    live.currentHeight = 11;
    live.currentFrame = accountFrame(11, `0x${'11'.repeat(32)}`);
    const env = withAccount(live);
    const proposal = accountFrame(12, `0x${'12'.repeat(32)}`);
    const output = routedAccountInput(live, {
      kind: 'ack_frame',
      fromEntityId: FROM,
      toEntityId: TO,
      domain: { ...live.state.domain },
      disputeConfig: { ...live.state.disputeConfig },
      ack: { height: 11, frameHash: live.currentFrame.stateHash, frameHanko: `0x${'aa'.repeat(65)}` },
      proposal: { frame: proposal, frameHanko: `0x${'bb'.repeat(65)}` },
    });

    expect(accountProposalSettledBySender(env, output)).toBe(false);
    expect(pruneSettledOutputs(env, [output])).toEqual([output]);
  });

  test('drops a proposal-only output once the sender no longer holds that pending frame', () => {
    const live = makeAccount(FROM, TO);
    live.currentHeight = 11;
    live.currentFrame = accountFrame(11, `0x${'11'.repeat(32)}`);
    const env = withAccount(live);
    const proposal = accountFrame(12, `0x${'12'.repeat(32)}`);
    const output = routedAccountInput(live, {
      kind: 'ack_frame',
      fromEntityId: FROM,
      toEntityId: TO,
      domain: { ...live.state.domain },
      disputeConfig: { ...live.state.disputeConfig },
      proposal: { frame: proposal, frameHanko: `0x${'bb'.repeat(65)}` },
    });

    expect(accountProposalSettledBySender(env, output)).toBe(true);
    expect(pruneSettledOutputs(env, [output])).toEqual([]);
  });

  test('fails loudly instead of pruning a proposal whose source Account vanished', () => {
    const live = makeAccount(FROM, TO);
    const proposal = accountFrame(12, `0x${'12'.repeat(32)}`);
    const output = routedAccountInput(live, {
      kind: 'ack_frame',
      fromEntityId: FROM,
      toEntityId: TO,
      domain: { ...live.state.domain },
      disputeConfig: { ...live.state.disputeConfig },
      proposal: { frame: proposal, frameHanko: `0x${'bb'.repeat(65)}` },
    });

    expect(() => pruneSettledOutputs({
      runtimeId: 'missing-source-account',
      state: { eReplicas: new Map() },
    } as unknown as RuntimeReplica, [output])).toThrow(
      'ACCOUNT_PROPOSAL_OUTBOX_SOURCE_ACCOUNT_MISSING',
    );
  });
});
