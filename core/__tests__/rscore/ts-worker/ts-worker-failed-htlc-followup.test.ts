import { describe, expect, test } from 'bun:test';

import { getEntityAccountForWrite } from '../../../entity/state/persistent-account-map';
import { createEmptyEnv } from '../../../runtime';
import { TsAccountWorkerAuthority } from '../../../runtime/workers/account';
import { createJReplica } from '../../../scenarios/harness/boot';
import { buildPreparedCrossJurisdictionRoute, buildCrossJurisdictionPullBinding } from '../../../extensions/cross-j';
import { selectCrossJOpeningAccountProposalTxs } from '../../../entity/transition/cross-j-proposer-materialization';
import type { AccountTx } from '../../../types/account';
import {
  addReplica,
  addr,
  entity,
  jref,
  makeAccount,
  makeJurisdiction,
  makeState,
  openWritableEntityAccounts,
  putTestAccountDelta,
} from '../../helpers/cross-j';

describe('TS Account worker genuine HTLC proposal rejection', () => {
  test('runs one outbound continuation and returns only the canonical upstream admission', async () => {
    const owner = entity('11');
    const downstream = entity('22');
    const upstream = entity('33');
    const signerId = `0x${'44'.repeat(20)}`;
    const jurisdiction = makeJurisdiction('worker-followup', 31_337, '55', '66');
    const state = makeState(owner, signerId, jurisdiction);
    const accounts = openWritableEntityAccounts(state);
    accounts.set(downstream, makeAccount(owner, downstream, jurisdiction));
    accounts.set(upstream, makeAccount(owner, upstream, jurisdiction));
    const hashlock = `0x${'5a'.repeat(32)}`;
    const upstreamAccount = getEntityAccountForWrite(state.accounts, upstream);
    if (!upstreamAccount) throw new Error('upstream Account missing');
    const upstreamDelta = upstreamAccount.state.deltas.get(1);
    if (!upstreamDelta) throw new Error('upstream delta missing');
    putTestAccountDelta(upstreamAccount, { ...upstreamDelta, rightHold: 10n });
    upstreamAccount.state.locks = upstreamAccount.state.locks.updated(hashlock, {
      lockId: hashlock,
      hashlock,
      timelock: 100_000n,
      revealBeforeHeight: 200,
      amount: 10n,
      tokenId: 1,
      senderIsLeft: false,
      createdHeight: 1,
      createdTimestamp: state.timestamp,
    });
    state.paybook.entries.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      inboundEntity: upstream,
      outboundEntity: downstream,
      pendingFee: 1n,
      createdTimestamp: state.timestamp,
    });
    const env = createEmptyEnv('ts-worker-failed-htlc-followup');
    const jReplica = createJReplica(env, jurisdiction.name, jurisdiction.depositoryAddress);
    jReplica.chainId = jurisdiction.chainId;
    jReplica.contracts = {
      ...jReplica.contracts,
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      account: `0x${'77'.repeat(20)}`,
      deltaTransformer: `0x${'88'.repeat(20)}`,
    };
    const authority = new TsAccountWorkerAuthority(env, 2);
    const common = {
      ownerEntityId: owner,
      ownerSignerId: signerId,
      unsupportedEntityTxTypes: [],
      occurrence: { kind: 'runtime-input' as const, inputIndex: 0 },
      deferProposal: false,
    };
    const inbound = authority.provider.executeAccountInboundBatch;
    const outbound = authority.provider.executeAccountOutboundBatch;
    if (!inbound || !outbound) throw new Error('worker batch provider missing');
    await inbound({
      ...common,
      expectedAccountsRoot: state.accounts.rootHash(),
      entityState: state,
      entityContext: undefined,
      requests: [],
    } as never);
    const downstreamAccount = getEntityAccountForWrite(state.accounts, downstream);
    if (!downstreamAccount) throw new Error('downstream Account missing');
    const expiredLock = {
      type: 'htlc_lock' as const,
      data: {
        lockId: hashlock,
        hashlock,
        timelock: BigInt(state.timestamp - 1),
        revealBeforeHeight: 200,
        amount: 10n,
        tokenId: 1,
      },
    };
    const result = await outbound({
      ...common,
      entityState: state,
      entityHeight: state.height + 1,
      accountForWrite: (accountId: string) => getEntityAccountForWrite(state.accounts, accountId),
      creates: [],
      admissions: [{
        account: downstreamAccount,
        input: { kind: 'enqueue', txs: [expiredLock] },
        entityTimestamp: state.timestamp,
        finalizedJHeight: 100,
      }],
      proposals: [{
        account: downstreamAccount,
        timestamp: state.timestamp,
        jHeight: 100,
        entityTimestamp: state.timestamp,
        finalizedJHeight: 100,
      }],
      envelopeUpdates: [],
      materializeAccountIds: [],
    } as never);
    expect(result.generatedAdmissions).toHaveLength(1);
    expect(result.generatedAdmissions[0]).toMatchObject({
      accountId: upstream,
      input: {
        kind: 'enqueue',
        txs: [{
          type: 'htlc_resolve',
          data: {
            lockId: hashlock,
            outcome: 'error',
          },
        }],
      },
      result: { ok: true, admittedAccountTxCount: 1 },
    });
    expect(result.generatedAdmissions[0]?.input.txs[0]?.data).toMatchObject({
      reason: expect.stringContaining('forward_failed:'),
    });
    expect(result.proposals.map(row => row.accountId)).toEqual([downstream, upstream]);
  });
});

const crossJWorkerFixture = (reciprocal: boolean) => {
  const env = createEmptyEnv('worker-cross-j-opening');
  env.quietRuntimeLogs = true;
  env.state.timestamp = 1_000;
  const sourceJ = makeJurisdiction('source-opening', 31_337, '55', '66');
  const targetJ = makeJurisdiction('target-opening', 31_338, '57', '68');
  for (const jurisdiction of [sourceJ, targetJ]) {
    const replica = createJReplica(env, jurisdiction.name, jurisdiction.depositoryAddress);
    replica.chainId = jurisdiction.chainId;
    replica.contracts = { ...replica.contracts, depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress, account: addr('77'), deltaTransformer: addr('88') };
  }
  const sourceUser = entity('11');
  const sourceHub = entity('22');
  const targetHub = entity('33');
  const targetUser = entity('44');
  const sourceSigner = addr('52');
  const signerId = addr('53');
  const state = makeState(targetHub, signerId, targetJ, targetUser);
  const sibling = makeState(sourceHub, sourceSigner, sourceJ, sourceUser);
  const account = getEntityAccountForWrite(state.accounts, targetUser);
  const siblingAccount = getEntityAccountForWrite(sibling.accounts, sourceUser);
  if (!account || !siblingAccount) throw new Error('WORKER_CROSS_J_ACCOUNT_MISSING');
  const txs: AccountTx[] = [];
  for (let index = 0; index < 9; index += 1) {
    const route = { ...buildPreparedCrossJurisdictionRoute({
      orderId: `opening-${index}`, makerEntityId: sourceUser, hubEntityId: sourceHub,
      sourceSignerId: addr('51'), sourceHubSignerId: sourceSigner,
      targetHubSignerId: signerId, targetSignerId: addr('54'),
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      source: { jurisdiction: jref(sourceJ), entityId: sourceUser,
        counterpartyEntityId: sourceHub, tokenId: 1, amount: 10n },
      target: { jurisdiction: jref(targetJ), entityId: targetHub,
        counterpartyEntityId: targetUser, tokenId: 1, amount: 9n },
      status: 'intent', createdAt: 1_000, updatedAt: 1_000, expiresAt: 61_000,
    }, { runtimeSeed: env.runtimeSeed, now: 1_000 }), status: 'resting' as const };
    for (const leg of ['source', 'target'] as const) {
      const pull = leg === 'source' ? route.sourcePull : route.targetPull;
      if (!pull) throw new Error('WORKER_CROSS_J_PULL_MISSING');
      const tx: AccountTx = { type: 'cross_pull_lock', data: {
        pullId: pull.pullId, tokenId: pull.tokenId, amount: pull.signedAmount,
        fullHash: pull.fullHash, partialRoot: pull.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding(route, leg), crossJurisdictionRoute: route,
      } };
      if (leg === 'target') txs.push(tx);
      else if (reciprocal) siblingAccount.mempool.push(tx);
    }
  }
  addReplica(env, sibling, sourceSigner);
  return { env, state, account, signerId, txs, accountId: targetUser };
};

describe('TS worker cross-j opening cohort', () => {
  test('failed htlc_lock continuation preserves a waiting cross_pull_lock cohort', async () => {
    const { env, state, account, signerId, txs, accountId } = crossJWorkerFixture(false);
    const downstream = entity('99');
    const jurisdiction = state.config.jurisdiction;
    if (!jurisdiction) throw new Error('WORKER_CROSS_J_JURISDICTION_MISSING');
    openWritableEntityAccounts(state).set(downstream, makeAccount(state.entityId, downstream, jurisdiction));
    const downstreamAccount = getEntityAccountForWrite(state.accounts, downstream);
    const delta = account.state.deltas.get(1);
    if (!downstreamAccount || !delta) throw new Error('WORKER_CROSS_J_FOLLOWUP_ACCOUNT_MISSING');
    const hashlock = `0x${'5a'.repeat(32)}`;
    putTestAccountDelta(account, { ...delta, rightHold: 10n });
    account.state.locks = account.state.locks.updated(hashlock, { lockId: hashlock, hashlock,
      timelock: 100_000n, revealBeforeHeight: 200, amount: 10n, tokenId: 1,
      senderIsLeft: false, createdHeight: 1, createdTimestamp: state.timestamp });
    state.paybook.entries.set(hashlock, { hashlock, tokenId: 1, amount: 10n,
      inboundEntity: accountId, outboundEntity: downstream, pendingFee: 1n, createdTimestamp: state.timestamp });
    const authority = new TsAccountWorkerAuthority(env, 1);
    const common = { ownerEntityId: state.entityId, ownerSignerId: signerId,
      unsupportedEntityTxTypes: [], occurrence: { kind: 'runtime-input' as const, inputIndex: 0 }, deferProposal: false };
    try {
      await authority.provider.executeAccountInboundBatch({ ...common,
        expectedAccountsRoot: state.accounts.rootHash(), entityState: state, entityContext: undefined, requests: [] });
      const expired: AccountTx = { type: 'htlc_lock', data: { lockId: hashlock, hashlock,
        timelock: 999n, revealBeforeHeight: 200, amount: 10n, tokenId: 1 } };
      const result = await authority.provider.executeAccountOutboundBatch({ ...common,
        entityState: state, entityHeight: 1, accountForWrite: id => getEntityAccountForWrite(state.accounts, id),
        admissions: [{ account, txs }, { account: downstreamAccount, txs: [expired] }].map(row => ({
          account: row.account, input: { kind: 'enqueue' as const, txs: row.txs },
          entityTimestamp: 1_000, finalizedJHeight: 0 })),
        proposals: [account, downstreamAccount].map(account => ({
          account, timestamp: 1_000, jHeight: 0, entityTimestamp: 1_000, finalizedJHeight: 0,
        })), envelopeUpdates: [], materializeAccountIds: [] });
      expect(result.generatedAdmissions).toHaveLength(1);
      expect(result.proposals.map(row => row.accountId)).toEqual([downstream]);
      expect(account.pendingFrame).toBeUndefined();
      expect(account.mempool.map(tx => tx.type)).toEqual([...txs.map(tx => tx.type), 'htlc_resolve']);
    } finally {
      await authority.close();
    }
  });

  for (const workers of [1, 4]) {
    for (const reciprocal of [false, true]) {
      test(`W${workers} cross_pull_lock ${reciprocal ? 'selects one of nine admitted orders' : 'waits for reciprocal opening'}`, async () => {
        const fixture = crossJWorkerFixture(reciprocal);
        const { env, state, account, signerId, txs, accountId } = fixture;
        const authority = new TsAccountWorkerAuthority(env, workers);
        const common = { ownerEntityId: state.entityId, ownerSignerId: signerId,
          unsupportedEntityTxTypes: [], occurrence: { kind: 'runtime-input' as const, inputIndex: 0 },
          deferProposal: false };
        try {
          await authority.provider.executeAccountInboundBatch({ ...common,
            expectedAccountsRoot: state.accounts.rootHash(), entityState: state,
            entityContext: undefined, requests: [] });
          const result = await authority.provider.executeAccountOutboundBatch({ ...common,
            entityState: state, entityHeight: 1,
            accountForWrite: id => getEntityAccountForWrite(state.accounts, id),
            admissions: [{ account,
              input: { kind: 'enqueue', txs }, entityTimestamp: 1_000, finalizedJHeight: 0 }],
            proposals: [{ account, timestamp: 1_000,
              jHeight: 0, entityTimestamp: 1_000, finalizedJHeight: 0 }],
            envelopeUpdates: [], materializeAccountIds: [] });
          if (!reciprocal) {
            expect(result.proposals).toHaveLength(0);
            expect(account.pendingFrame).toBeUndefined();
            expect(account.mempool).toHaveLength(9);
            expect(selectCrossJOpeningAccountProposalTxs(env, state, account)).toBeNull();
          } else {
            const proposal = result.proposals[0]?.result;
            expect(proposal?.ok && proposal.outcome).toBe('proposed');
            expect(account.pendingFrame?.accountTxs).toEqual([txs[0]]);
            expect(account.mempool).toEqual(txs.slice(1));
            expect(result.proposals.map(row => row.accountId)).toEqual([accountId]);
          }
        } finally {
          await authority.close();
        }
      });
    }
  }
});
