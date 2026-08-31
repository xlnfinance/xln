import { describe, expect, test } from 'bun:test';

import { getEntityAccountForWrite } from '../../../entity/state/persistent-account-map';
import { createEmptyEnv } from '../../../runtime';
import { TsAccountWorkerAuthority } from '../../../rscore/ts-worker';
import { createJReplica } from '../../../scenarios/harness/boot';
import {
  entity,
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
        collectorFrameId: owner,
        account: downstreamAccount,
        input: { kind: 'enqueue', txs: [expiredLock] },
        entityTimestamp: state.timestamp,
        finalizedJHeight: 100,
      }],
      proposals: [{
        collectorFrameId: owner,
        account: downstreamAccount,
        timestamp: state.timestamp,
        jHeight: 100,
        entityTimestamp: state.timestamp,
        finalizedJHeight: 100,
        selectionIsWholeMempool: true,
      }],
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
