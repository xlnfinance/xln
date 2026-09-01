import { describe, expect, test } from 'bun:test';

import {
  admitEntityTransactions,
  appendEntityMempoolTransactions,
} from '../../../entity/consensus/input/admission';
import type { ApplyEntityInputContext } from '../../../entity/consensus/input/types';
import { removeCommittedTxsFromMempool } from '../../../protocol/state/tx-multiset';
import type { EntityTx } from '../../../types/entity-tx';
import { createEntityProposalFixture } from '../../helpers/entity-proposal-fixture';

const hash = (byte: string): string => `0x${byte.repeat(64)}`;

const accountInputTx = (): Extract<EntityTx, { type: 'accountInput' }> => ({
  type: 'accountInput',
  data: {
    kind: 'ack_frame',
    fromEntityId: hash('1'),
    toEntityId: hash('2'),
    domain: { chainId: 31_337, depositoryAddress: `0x${'3'.repeat(40)}` },
    disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 20 },
    proposal: {
      frame: {
        height: 1,
        timestamp: 1_000,
        jHeight: 7,
        byLeft: true,
        prevFrameHash: 'genesis',
        accountStateRoot: hash('4'),
        stateHash: hash('5'),
        accountTxs: [
          { type: 'direct_payment', data: { tokenId: 1, amount: 7n } },
          { type: 'direct_payment', data: { tokenId: 1, amount: 7n } },
        ],
        deltas: [],
      },
      frameHanko: '0xframe-hanko',
    },
  },
});

const fixture = createEntityProposalFixture('entity-account-input-mempool-dedupe');

const admissionContext = (
  validator: ReturnType<typeof fixture.createValidator>,
  entityTxs: EntityTx[],
): ApplyEntityInputContext => ({
  env: validator.env,
  entityInput: {
    entityId: fixture.entityId,
    signerId: validator.signerId,
    entityTxs,
  },
  workingReplica: validator.replica,
  entityOutbox: [],
  jOutbox: [],
  candidateEffects: [],
  storageChanges: [],
  frameHash: 'genesis',
  promoteCandidateState: true,
  usePersistedReplayContext: false,
});

describe('Entity AccountInput mempool identity', () => {
  test('one validator ingress forwarded repeatedly enters proposer mempool once', async () => {
    const ingress = accountInputTx();
    const validator = fixture.createValidator('2');
    const forwarded = [];
    for (let consensusStep = 0; consensusStep < 4; consensusStep += 1) {
      const context = admissionContext(
        validator,
        consensusStep === 0 ? [structuredClone(ingress)] : [],
      );
      await admitEntityTransactions(context, false);
      forwarded.push(...context.entityOutbox);
    }

    expect(validator.replica.mempool).toHaveLength(1);
    expect(forwarded).toHaveLength(4);
    const proposer = fixture.createValidator('1');
    for (const retry of forwarded) {
      const context = admissionContext(proposer, retry.entityTxs ?? []);
      await admitEntityTransactions(context, false);
    }

    expect(proposer.replica.mempool).toHaveLength(1);
    expect(proposer.replica.mempool[0]).toEqual(ingress);
    expect(proposer.replica.mempool[0]?.type === 'accountInput'
      ? proposer.replica.mempool[0].data.proposal.frame.accountTxs
      : []).toHaveLength(2);
    proposer.replica.mempool = removeCommittedTxsFromMempool(
      proposer.replica.mempool,
      proposer.replica.mempool,
    );
    expect(proposer.replica.mempool).toEqual([]);

    const lateRetry = admissionContext(proposer, [structuredClone(ingress)]);
    await admitEntityTransactions(lateRetry, false);
    expect(proposer.replica.mempool).toEqual([ingress]);
  });

  test('collapses same-batch retries without changing input order', () => {
    const ingress = accountInputTx();
    const firstChat = { type: 'chat', data: { from: 'a', message: 'one' } } as EntityTx;
    const secondChat = { type: 'chat', data: { from: 'a', message: 'two' } } as EntityTx;
    const result = appendEntityMempoolTransactions([], [
      firstChat,
      ingress,
      structuredClone(ingress),
      secondChat,
    ]);

    expect(result).toEqual([firstChat, ingress, secondChat]);
  });

  test('keeps different full-wire Account inputs and non-Account multiplicity', () => {
    const first = accountInputTx();
    const second = structuredClone(first);
    second.data.proposal.frameHanko = '0xdifferent-hanko';
    const chat = { type: 'chat', data: { from: 'a', message: 'repeat' } } as EntityTx;

    expect(appendEntityMempoolTransactions([], [first, second])).toHaveLength(2);
    expect(appendEntityMempoolTransactions([], [chat, structuredClone(chat)])).toHaveLength(2);
  });
});
