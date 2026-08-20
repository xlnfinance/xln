import { describe, expect, test } from 'bun:test';

import { accountProposalSettledBySender } from '../../../runtime/delivery/identity';
import { pruneSettledOutputs } from '../../../runtime/delivery/pending';
import { executeCrontab, initCrontab } from '../../../entity/scheduler';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { createEmptyEnv } from '../../../runtime';
import { entity, makeAccount, makeConfig, makeJurisdiction } from '../../helpers/cross-j';
import type { AccountFrame, AccountReplica } from '../../../types/account';
import type { EntityReplica } from '../../../entity/types';
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
  test('keeps a bundled frame_ack after the successor pending frame is gone', () => {
    const live = makeAccount(FROM, TO);
    live.currentHeight = 11;
    live.currentFrame = accountFrame(11, `0x${'11'.repeat(32)}`);
    const env = withAccount(live);
    const proposal = accountFrame(12, `0x${'12'.repeat(32)}`);
    const output = routedAccountInput(live, {
      kind: 'frame_ack',
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
      kind: 'frame',
      fromEntityId: FROM,
      toEntityId: TO,
      domain: { ...live.state.domain },
      disputeConfig: { ...live.state.disputeConfig },
      proposal: { frame: proposal, frameHanko: `0x${'bb'.repeat(65)}` },
    });

    expect(accountProposalSettledBySender(env, output)).toBe(true);
    expect(pruneSettledOutputs(env, [output])).toEqual([]);
  });
});

describe('pending Account resend cache', () => {
  test('crontab fail-fasts when pendingFrame has no matching pendingAccountInput', async () => {
    const env = createEmptyEnv('pending-resend-cache-missing');
    env.quietRuntimeLogs = true;
    const jurisdiction = makeJurisdiction('resend-cache', 31_337, 'a1', 'a2');
    const account = makeAccount(FROM, TO, {
      chainId: jurisdiction.chainId,
      depositoryAddress: jurisdiction.depositoryAddress,
    });
    account.pendingFrame = {
      ...accountFrame(11, `0x${'cd'.repeat(32)}`),
      timestamp: 1_000,
    };
    const replica = {
      entityId: FROM,
      signerId: '1',
      mempool: [],
      isProposer: true,
      state: {
        entityId: FROM,
        height: 1,
        timestamp: 100_000,
        nonces: new Map(),
        proposals: new Map(),
        config: makeConfig('1', jurisdiction),
        reserves: new Map(),
        accounts: PersistentEntityAccountMap.fromMap(
          new Map([[TO, account]]),
          FROM,
          computeEntityAccountValueHash,
        ),
        lastFinalizedJHeight: 0,
        profile: { name: '', isHub: false, avatar: '', bio: '', website: '' },
        crontabState: initCrontab(),
      },
    } as EntityReplica;

    await expect(executeCrontab(env, replica, replica.state.crontabState!, {
      manualBroadcastInInput: false,
      accountChanges: new Set(),
    })).rejects.toThrow('PENDING_ACCOUNT_RESEND_CACHE_MISSING');
  });

  test('crontab resends a bundled frame_ack after the liveness window', async () => {
    const env = createEmptyEnv('pending-resend-frame-ack');
    env.quietRuntimeLogs = true;
    const jurisdiction = makeJurisdiction('resend-frame-ack', 31_337, 'a1', 'a2');
    const account = makeAccount(FROM, TO, {
      chainId: jurisdiction.chainId,
      depositoryAddress: jurisdiction.depositoryAddress,
    });
    const pendingFrame = {
      ...accountFrame(11, `0x${'cd'.repeat(32)}`),
      timestamp: 1_000,
    };
    account.pendingFrame = pendingFrame;
    account.pendingAccountInput = {
      kind: 'frame_ack',
      fromEntityId: FROM,
      toEntityId: TO,
      domain: { ...account.state.domain },
      disputeConfig: { ...account.state.disputeConfig },
      ack: { height: 10, frameHash: pendingFrame.prevFrameHash, frameHanko: `0x${'12'.repeat(65)}` },
      proposal: { frame: pendingFrame, frameHanko: `0x${'34'.repeat(65)}` },
    };
    const replica = {
      entityId: FROM,
      signerId: '1',
      mempool: [],
      isProposer: true,
      state: {
        entityId: FROM,
        height: 1,
        timestamp: 100_000,
        nonces: new Map(),
        proposals: new Map(),
        config: makeConfig('1', jurisdiction),
        reserves: new Map(),
        accounts: PersistentEntityAccountMap.fromMap(
          new Map([[TO, account]]),
          FROM,
          computeEntityAccountValueHash,
        ),
        lastFinalizedJHeight: 0,
        profile: { name: '', isHub: false, avatar: '', bio: '', website: '' },
        crontabState: initCrontab(),
      },
    } as EntityReplica;

    const outputs = await executeCrontab(env, replica, replica.state.crontabState!, {
      manualBroadcastInInput: false,
      accountChanges: new Set(),
    });
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.entityTxs).toEqual([{ type: 'accountInput', data: account.pendingAccountInput }]);
  });

  test('crontab fail-fasts when pendingAccountInput height does not match pendingFrame', async () => {
    const env = createEmptyEnv('pending-resend-height-mismatch');
    env.quietRuntimeLogs = true;
    const jurisdiction = makeJurisdiction('resend-height-mismatch', 31_337, 'a1', 'a2');
    const account = makeAccount(FROM, TO, {
      chainId: jurisdiction.chainId,
      depositoryAddress: jurisdiction.depositoryAddress,
    });
    const pendingFrame = {
      ...accountFrame(11, `0x${'cd'.repeat(32)}`),
      timestamp: 1_000,
    };
    const cachedFrame = {
      ...accountFrame(10, `0x${'ab'.repeat(32)}`),
      timestamp: 1_000,
    };
    account.pendingFrame = pendingFrame;
    account.pendingAccountInput = {
      kind: 'frame',
      fromEntityId: FROM,
      toEntityId: TO,
      domain: { ...account.state.domain },
      disputeConfig: { ...account.state.disputeConfig },
      proposal: { frame: cachedFrame, frameHanko: `0x${'34'.repeat(65)}` },
    };
    const replica = {
      entityId: FROM,
      signerId: '1',
      mempool: [],
      isProposer: true,
      state: {
        entityId: FROM,
        height: 1,
        timestamp: 100_000,
        nonces: new Map(),
        proposals: new Map(),
        config: makeConfig('1', jurisdiction),
        reserves: new Map(),
        accounts: PersistentEntityAccountMap.fromMap(
          new Map([[TO, account]]),
          FROM,
          computeEntityAccountValueHash,
        ),
        lastFinalizedJHeight: 0,
        profile: { name: '', isHub: false, avatar: '', bio: '', website: '' },
        crontabState: initCrontab(),
      },
    } as EntityReplica;

    await expect(executeCrontab(env, replica, replica.state.crontabState!, {
      manualBroadcastInInput: false,
      accountChanges: new Set(),
    })).rejects.toThrow('PENDING_ACCOUNT_RESEND_HEIGHT_MISMATCH');
  });
});
