import { strict as assert } from 'node:assert';
import { bank, borrower, command, fundedLoan, replica } from '../lending-runtime';
import { closeInfraDb, closeRuntimeDb } from '../../../../runtime';
import { computeAccountStateRootCold } from '../../../../account/commitment/state-root';
import { safeStringify } from '../../../../protocol/serialization';
import { registerStructuredLogSink, type StructuredLogEvent } from '../../../../support/logger';

if (!process.env['XLN_DB_PATH']) throw new Error('ISOLATED_LENDING_DB_REQUIRED');
const env = await fundedLoan();
const logs: StructuredLogEvent[] = [];
const unsubscribe = registerStructuredLogSink(event => {
  if (event.scope === 'runtime.entity_inputs') logs.push(event);
});
try {
  const loan = [...(replica(env, bank).state.lending?.loans.values() ?? [])][0];
  assert(loan);
  assert.equal(loan.status, 'active');
  const repayment = {
    type: 'lendingRepay' as const,
    data: {
      hubEntityId: bank.entityId,
      loanId: loan.loanId,
      tokenId: 1,
      amount: 2_600n,
    },
  };
  await command(env, borrower, repayment);
  const settled = replica(env, bank).state.lending?.loans.get(loan.loanId);
  assert(settled);
  assert.equal(settled.status, 'repaid');
  const accounts = () =>
    [bank, borrower].map(party => {
      const other = party === bank ? borrower : bank;
      const account = replica(env, party).state.accounts.get(other.entityId);
      assert(account);
      assert.equal(account.state.subcontracts?.has(loan.loanId) ?? false, false);
      return computeAccountStateRootCold(account.state);
    });
  const roots = accounts();
  const book = safeStringify(replica(env, bank).state.lending);
  console.log(
    'LENDING_STALE_REPAY_PRECONDITION',
    safeStringify({ loanId: loan.loanId, status: settled.status, repaidAmount: settled.repaidAmount, roots }),
  );
  // A separately signed user command after full repayment is a typed rejection,
  // never an invariant failure, another payment, or a dead Runtime.
  await command(env, borrower, { ...repayment, data: { ...repayment.data, amount: 1n } });
  assert.deepEqual(accounts(), roots);
  assert.equal(safeStringify(replica(env, bank).state.lending), book);
  assert.notEqual(env.infrastructure?.halted, true);
  assert.equal(replica(env, borrower).mempool.length, 0);
  assert.deepEqual(
    logs.filter(event => event.message === 'entity_input.batch_tx_evicted').map(event => event['rejection']),
    [`LENDING_LOAN_NOT_FOUND:${loan.loanId}`],
  );
  await command(env, borrower, {
    type: 'profile-update',
    data: {
      profile: { entityId: borrower.entityId, name: 'Live after stale repayment' },
    },
  });
  assert.equal(replica(env, borrower).state.profile.name, 'Live after stale repayment');
  assert.deepEqual(accounts(), roots);
  console.log('LENDING_STALE_REPAY_GREEN');
} finally {
  unsubscribe();
  await closeRuntimeDb(env);
  await closeInfraDb(env);
}
