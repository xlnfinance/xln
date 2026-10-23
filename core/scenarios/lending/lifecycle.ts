/** Signed bank IOUs: funding, facility, fractional repay, exact default and savings exit. */
import assert from 'node:assert/strict';
import { defaultAccountDisputeConfigForParties } from '../../account/config/dispute-config';
import { deriveAccountWatchSeed } from '../../protocol/identity/account-watch-seed';
import { processRuntime } from '../../runtime';
import { createDueScheduledWakeInputs } from '../../runtime/mempool/scheduled-wake';
import type { RuntimeReplica } from '../../runtime/types';
import type { EntityTx } from '../../types/entity-tx';
import { safeStringify } from '../../protocol/serialization';
import { bootScenario, registerEntities, type RegisteredEntity } from '../harness/boot';
import { assertRuntimeIdle, converge, findReplica, readScenarioJurisdictionUnix } from '../harness/helpers';
import { assertLendingEvidence, lendingAccount, lendingBalance } from './evidence';

const TERM_MS = 3_600_000;
const POSITION = 'lend-1111111111111111';
const REQUEST = 'borrow-2222222222222222';

const command = async (env: RuntimeReplica, party: RegisteredEntity, tx: EntityTx): Promise<void> => {
  await processRuntime(env, [{ entityId: party.id, signerId: party.signer, entityTxs: [tx] }]);
  await converge(env, 40);
};

const at = async (env: RuntimeReplica, bank: RegisteredEntity, timestamp: number): Promise<void> => {
  // The canonical scenario Runtime advances each accepted frame by 100 ms.
  // Each boundary uses an independent run, so no committed clock is rewound.
  assert(timestamp - 100 >= env.state.timestamp, 'scenario time must be monotonic');
  const wakes = createDueScheduledWakeInputs(env, timestamp);
  env.state.timestamp = timestamp - 100;
  const observation = {
    entityId: bank.id,
    signerId: bank.signer,
    entityTxs: [{ type: 'chat', data: { from: bank.signer, message: `lending boundary ${timestamp}` } }],
  } satisfies import('../../entity/types').EntityInput;
  await processRuntime(env, wakes.some(input => input.entityId === bank.id) ? wakes : [...wakes, observation]);
  assert.equal(findReplica(env, bank.id)[1].state.timestamp, timestamp);
};

export async function lendingLifecycle(
  runtimeReplica: RuntimeReplica,
  deadlineOffset: -1 | 0 | 1 = 0,
): Promise<RuntimeReplica> {
  const { env, jadapter, jurisdiction } = await bootScenario({
    name: 'lending-lifecycle',
    signerIds: ['1', '2', '3'],
    runtimeReplica,
    storageEnabled: true,
  });
  env.quietRuntimeLogs = true;
  env.state.timestamp = (await readScenarioJurisdictionUnix(jadapter)) * 1000;
  assert(env.infrastructure);
  env.infrastructure.maxEntityInputsPerFrame = 1;
  const [bank, saver, borrower] = await registerEntities(
    env,
    jadapter,
    [
      { name: 'Bank', signer: '1', position: { x: 0, y: 0, z: 0 } },
      { name: 'Saver', signer: '2', position: { x: -20, y: 0, z: 0 } },
      { name: 'Borrower', signer: '3', position: { x: 20, y: 0, z: 0 } },
    ],
    jurisdiction,
  );
  assert(bank && saver && borrower && env.runtimeSeed && env.runtimeId);
  for (const user of [saver, borrower]) {
    const watchSeed = deriveAccountWatchSeed({
      runtimeSeed: env.runtimeSeed,
      runtimeId: env.runtimeId,
      entityId: bank.id,
      counterpartyId: user.id,
    });
    await processRuntime(
      env,
      [bank, user].map(party => {
        const peer = party === bank ? user : bank;
        return {
          entityId: party.id,
          signerId: party.signer,
          entityTxs: [
            {
              type: 'openAccount' as const,
              data: {
                targetEntityId: peer.id,
                tokenId: 1,
                creditAmount: 100_000n,
                watchSeed,
                disputeConfig: defaultAccountDisputeConfigForParties(party.id, false, peer.id, false),
              },
            },
          ],
        };
      }),
    );
    await converge(env, 40);
    await command(env, bank, {
      type: 'directPayment',
      data: {
        targetEntityId: user.id,
        tokenId: 1,
        amount: 10_000n,
        route: [bank.id, user.id],
        deliveryMode: 'direct',
      },
    });
  }
  await command(env, bank, { type: 'setHubConfig', data: {} });
  const expiresAt = env.state.timestamp + 10 * TERM_MS;
  const domain = lendingAccount(env, bank, borrower).state.domain;
  await command(env, bank, {
    type: 'lendingSetTerms',
    data: {
      ...domain,
      tokenId: 1,
      termId: '1h',
      savingsInterestBps: 100,
      loanInterestBps: 200,
      loanLateMs: TERM_MS,
      expiresAt,
    },
  });
  await command(env, bank, {
    type: 'lendingApprove',
    data: {
      borrowerEntityId: borrower.id,
      tokenId: 1,
      termId: '1h',
      maxPrincipal: 2_500n,
      expiresAt,
    },
  });
  await command(env, saver, {
    type: 'lendingOffer',
    data: {
      positionId: POSITION,
      hubEntityId: bank.id,
      tokenId: 1,
      amount: 5_000n,
      termId: '1h',
      interestBps: 100,
    },
  });
  const borrow: EntityTx = {
    type: 'lendingBorrow',
    data: {
      requestId: REQUEST,
      hubEntityId: bank.id,
      tokenId: 1,
      amount: 2_500n,
      termId: '1h',
      maxInterestBps: 200,
      maxLateMs: TERM_MS,
      expiresAt: env.state.timestamp + 300_000,
    },
  };
  await command(env, borrower, borrow);
  const book = () => {
    const value = findReplica(env, bank.id)[1].state.lending;
    assert(value);
    return value;
  };
  const loan = () => {
    assert.equal(
      book().loans.size,
      1,
      safeStringify({
        book: book(),
        saver: lendingAccount(env, saver, bank).state,
        borrower: lendingAccount(env, borrower, bank).state,
      }),
    );
    const value = [...book().loans.values()][0];
    assert(value);
    return value;
  };
  assert.equal(loan().status, 'active');
  assert.equal(lendingBalance(env, borrower, bank), 12_500n);
  assert.equal(lendingBalance(env, saver, bank), 5_000n);
  await assertLendingEvidence(env, bank, [saver, borrower]);
  const beforeDuplicate = safeStringify(book());
  await command(env, borrower, borrow);
  assert.equal(safeStringify(book()), beforeDuplicate);
  assert.equal(lendingBalance(env, borrower, bank), 12_500n);

  await at(env, bank, loan().openedAt + TERM_MS / 2 + 1);
  await command(env, borrower, {
    type: 'lendingRepay',
    data: {
      hubEntityId: bank.id,
      loanId: loan().loanId,
      tokenId: 1,
      amount: 1_025n,
    },
  });
  assert.equal(loan().principalAmount, 1_500n);
  assert.equal(loan().repaidAmount, 1_025n);
  assert(loan().interestRemainder > 0n, 'fractional interest must survive the committed transition');
  const savingsBeforeDefault = safeStringify(book().savings);
  const reserves = () => safeStringify([...env.state.eReplicas.values()].map(replica => replica.state.reserves));
  const reservesBeforeDefault = reserves();
  const dueAt = loan().dueAt;
  await at(env, bank, dueAt + deadlineOffset);
  assert.equal(loan().status, deadlineOffset < 0 ? 'active' : 'defaulted', `signed deadline offset=${deadlineOffset}`);
  assert.equal(safeStringify(book().savings), savingsBeforeDefault, 'default cannot erase saver liabilities');
  assert.equal(reserves(), reservesBeforeDefault, 'default cannot invent reserves');
  await at(env, bank, dueAt + 1_000);
  assert.equal(loan().status, 'defaulted');

  await command(env, borrower, {
    type: 'lendingRepay',
    data: {
      hubEntityId: bank.id,
      loanId: loan().loanId,
      tokenId: 1,
      amount: 20_000n,
    },
  });
  assert.equal(loan().status, 'repaid');
  assert.equal(loan().repaidAmount, 2_540n, '25 interest before partial repay, then 15 on remaining principal');
  assert.equal(lendingBalance(env, borrower, bank), 9_960n, 'overpayment debits only the exact outstanding amount');
  await command(env, saver, { type: 'lendingClosePosition', data: { hubEntityId: bank.id, positionId: POSITION } });
  assert.equal(book().savings.get(POSITION)?.status, 'closed');
  assert.equal(lendingBalance(env, saver, bank), 10_050n, 'mature savings principal plus the 1% signed coupon');
  for (const user of [saver, borrower])
    for (const [owner, peer] of [
      [bank, user],
      [user, bank],
    ]) {
      assert(owner && peer);
      assert.equal(lendingAccount(env, owner, peer).state.subcontracts?.size, 0);
    }
  await assertLendingEvidence(env, bank, [saver, borrower]);
  assertRuntimeIdle(env, 'lending-lifecycle');
  console.log(`LENDING_LIFECYCLE_GREEN:repayment=2540:savings=5050:deadline=${dueAt}:offset=${deadlineOffset}`);
  return env;
}
