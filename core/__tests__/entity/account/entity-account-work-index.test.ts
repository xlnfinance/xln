import { describe, expect, test } from 'bun:test';

import {
  getProposableAccountIds,
  getPendingAccountIds,
  getQueuedAccountIds,
  getRebalanceAccountIds,
  hasProposableAccount,
} from '../../../entity/consensus/account/work-index';
import { hasEntityLeaderWork } from '../../../entity/consensus/leader';
import {
  collectReadyLocalAccountWorkTargets,
  shouldQueueCommittedAccountWork,
} from '../../../runtime/admit/entity-input-output';
import { shouldKeepPreparedEntityFrame } from '../../../entity/consensus/proposal/selection';
import type { EntityReplica } from '../../../entity/types';
import {
  commitEntityFrameCandidateState,
  createEntityFrameCandidateState,
} from '../../../entity/state-clone';
import { getEntityAccountForWrite, PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { requirePersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import {
  entity,
  makeAccount,
  makeJurisdiction,
  makeState,
} from '../../helpers/cross-j';

describe('Entity Account work indexes', () => {
  test('tracks only touched queued/pending Accounts and forks independently', () => {
    const self = entity('11');
    const counterparty = entity('22');
    const state = makeState(
      self,
      'validator',
      makeJurisdiction('account-work-index', 31_337, 'aa', 'bb'),
      counterparty,
    );

    expect([...getQueuedAccountIds(state)]).toEqual([]);
    const candidate = createEntityFrameCandidateState(state);
    const account = getEntityAccountForWrite(candidate.accounts, counterparty);
    if (!account) throw new Error('TEST_ACCOUNT_WRITE_SHELL_MISSING');
    account.mempool.push({
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount: 1n,
        route: [self],
        deliveryMode: 'direct',
        fromEntityId: self,
        toEntityId: counterparty,
      },
    });
    expect([...getQueuedAccountIds(candidate)]).toEqual([counterparty]);
    expect(getProposableAccountIds(candidate)).toEqual([counterparty]);
    expect(hasProposableAccount(candidate)).toBe(true);
    const pendingFrame = {
      ...account.currentFrame,
      height: 1,
      timestamp: 1,
      prevFrameHash: 'genesis',
      stateHash: `0x${'22'.repeat(32)}`,
    };
    account.pendingFrame = pendingFrame;
    account.pendingAccountInput = {
      kind: 'ack_frame',
      fromEntityId: self,
      toEntityId: counterparty,
      domain: account.state.domain,
      disputeConfig: account.state.disputeConfig,
      proposal: {
        frame: pendingFrame,
        disputeHanko: {
          hash: `0x${'33'.repeat(32)}`,
          proofBodyHash: `0x${'44'.repeat(32)}`,
          proofNonce: 1,
        },
      },
    };
    account.state.requestedRebalance = requirePersistentAccountStateMap(
      account.state.requestedRebalance,
      'requestedRebalance',
    ).updated(1, 10n);
    expect([...getPendingAccountIds(candidate)]).toEqual([counterparty]);
    expect([...getRebalanceAccountIds(candidate)]).toEqual([counterparty]);

    const committed = commitEntityFrameCandidateState(candidate);
    const recovered = {
      ...committed,
      accounts: PersistentEntityAccountMap.fromMap(
        new Map(committed.accounts),
        self,
        computeEntityAccountValueHash,
      ),
    };
    expect([...getQueuedAccountIds(recovered)]).toEqual([counterparty]);
    expect([...getPendingAccountIds(recovered)]).toEqual([counterparty]);
    expect([...getRebalanceAccountIds(recovered)]).toEqual([counterparty]);
    expect([...getQueuedAccountIds(state)]).toEqual([]);
  });

  test('does not requeue Account work while Entity consensus is in flight', () => {
    const self = entity('41');
    const counterparty = entity('42');
    const state = makeState(
      self,
      'validator',
      makeJurisdiction('account-work-scheduler', 31_337, 'da', 'db'),
    );
    const account = makeAccount(self, counterparty);
    account.mempool.push({
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount: 1n,
        route: [self],
        deliveryMode: 'direct',
        fromEntityId: self,
        toEntityId: counterparty,
      },
    });
    state.accounts = state.accounts.updated(counterparty, account);

    expect(shouldQueueCommittedAccountWork(true, state, false, false)).toBe(true);
    expect(shouldQueueCommittedAccountWork(true, state, true, false)).toBe(false);
    expect(shouldQueueCommittedAccountWork(false, state, false, false)).toBe(false);
    expect(shouldQueueCommittedAccountWork(true, state, false, true)).toBe(false);
  });

  test('drops an Account-work preview that produced no Account frame', () => {
    const accountWork = {
      accountWorkOnly: true,
      proposalTxs: [],
      shouldRollFrozenBaseJPrefixRound: false,
    } as const;
    expect(shouldKeepPreparedEntityFrame(accountWork, 0)).toBe(false);
    expect(shouldKeepPreparedEntityFrame(accountWork, 1)).toBe(true);
    expect(shouldKeepPreparedEntityFrame({
      ...accountWork,
      accountWorkOnly: false,
    }, 0)).toBe(true);
  });

  test('a sibling Entity commit re-wakes every ready local leader', () => {
    const jurisdiction = makeJurisdiction('account-work-cohort', 31_337, 'ea', 'eb');
    const sourceId = entity('51');
    const targetId = entity('52');
    const sourceState = makeState(sourceId, 'source-leader', jurisdiction);
    const targetState = makeState(targetId, 'target-leader', jurisdiction);
    const queuePayment = (state: typeof sourceState, counterparty: string): void => {
      const account = makeAccount(state.entityId, counterparty);
      account.mempool.push({
        type: 'direct_payment',
        data: {
          tokenId: 1,
          amount: 1n,
          route: [state.entityId],
          deliveryMode: 'direct',
          fromEntityId: state.entityId,
          toEntityId: counterparty,
        },
      });
      state.accounts = state.accounts.updated(counterparty, account);
    };
    queuePayment(sourceState, targetId);
    queuePayment(targetState, sourceId);

    const replicas: EntityReplica[] = [
      {
        entityId: sourceId,
        signerId: 'source-leader',
        state: sourceState,
        mempool: [],
        isProposer: true,
      },
      {
        entityId: targetId,
        signerId: 'target-leader',
        state: targetState,
        mempool: [],
        isProposer: true,
      },
      {
        entityId: sourceId,
        signerId: 'source-follower',
        state: sourceState,
        mempool: [],
        isProposer: false,
      },
    ];

    expect(collectReadyLocalAccountWorkTargets(replicas)).toEqual([
      { entityId: sourceId, signerId: 'source-leader' },
      { entityId: targetId, signerId: 'target-leader' },
    ]);
  });

  test('leader liveness reads the derived work index without rehashing Account leaves', () => {
    const self = entity('31');
    const counterparty = entity('32');
    const state = makeState(
      self,
      'validator',
      makeJurisdiction('leader-work-index', 31_337, 'ca', 'cb'),
      counterparty,
    );
    let valueHashes = 0;
    state.accounts = PersistentEntityAccountMap.fromMap(
      new Map(state.accounts),
      self,
      account => {
        valueHashes += 1;
        return computeEntityAccountValueHash(account);
      },
    );
    valueHashes = 0;

    const replica = { state, mempool: [] } as EntityReplica;
    expect(hasEntityLeaderWork(replica)).toBe(false);
    expect(valueHashes).toBe(0);

    const candidate = createEntityFrameCandidateState(state);
    const account = getEntityAccountForWrite(candidate.accounts, counterparty);
    if (!account) throw new Error('TEST_ACCOUNT_WRITE_SHELL_MISSING');
    account.mempool.push({
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount: 1n,
        route: [self],
        deliveryMode: 'direct',
        fromEntityId: self,
        toEntityId: counterparty,
      },
    });
    const candidateReplica = { state: candidate, mempool: [] } as EntityReplica;
    expect(hasEntityLeaderWork(candidateReplica)).toBe(true);
    expect(valueHashes).toBe(0);
  });
});
