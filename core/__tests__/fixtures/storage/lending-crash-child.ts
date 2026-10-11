import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeInfraDb, closeRuntimeDb, loadEnvFromDB, processRuntime } from '../../../runtime';
import { converge } from '../../../scenarios/harness/helpers';
import { safeStringify } from '../../../protocol/serialization';
import { computeAccountStateRootCold } from '../../../account/commitment/state-root';
import type { RuntimeReplica } from '../../../runtime/types';
import { bank, borrower, command, fundedLoan, positionId, replica, saver, seed, termMs } from './lending-runtime';

const mode = process.argv[2];
const output = process.env['XLN_DB_PATH'];
if (!output) throw new Error('LENDING_FIXTURE_DB_PATH_REQUIRED');

function book(env: RuntimeReplica) {
  const state = replica(env, bank).state.lending;
  assert(state);
  const loan = [...state.loans.values()][0];
  const pool = state.pools.get(positionId);
  assert(loan && pool);
  return { loan, pool };
}

function account(env: RuntimeReplica, party: typeof bank, peer: typeof bank) {
  const value = replica(env, party).state.accounts.get(peer.entityId);
  assert(value);
  return value;
}

function balance(env: RuntimeReplica, party: typeof bank, peer: typeof bank) {
  const value = account(env, party, peer);
  const delta = value.state.deltas.get(1);
  assert(delta);
  assert.equal(delta.collateral, 0n);
  return value.state.leftEntity === party.entityId ? delta.offdelta : -delta.offdelta;
}

function financialState(env: RuntimeReplica) {
  const { loan, pool } = book(env);
  const accounts = [bank, borrower].map(party => {
    const peer = party === bank ? borrower : bank;
    const value = account(env, party, peer);
    return { entityId: party.entityId, height: value.currentHeight,
      root: computeAccountStateRootCold(value.state), pending: Boolean(value.pendingFrame),
      balance: balance(env, party, peer), claim: value.state.subcontracts?.get(loan.loanId) };
  });
  return { height: env.state.height, timestamp: env.state.timestamp, loan, pool, accounts,
    borrowerBalance: balance(env, borrower, bank),
    saverBalance: balance(env, saver, bank) };
}

function evidence(env: RuntimeReplica, name: string) {
  const { loan } = book(env);
  writeFileSync(join(output!, `${name}.json`), safeStringify(financialState(env), 2));
  console.log(`LENDING_CRASH_EVIDENCE:${name}:height=${env.state.height}:status=${loan.status}`);
}

if (mode === 'originate') {
  const env = await fundedLoan();
  assert.equal(book(env).loan.status, 'active');
  assert.equal(balance(env, borrower, bank), 12_500n);
  assert.equal(balance(env, saver, bank), 5_000n);
  evidence(env, 'active');
  process.kill(process.pid, 'SIGKILL');
} else {
  const env = await loadEnvFromDB(bank.signerId, seed);
  assert(env);
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  const previous = mode === 'mature' ? 'active' : mode === 'repay' ? 'defaulted'
    : mode === 'recover' ? 'interleaved' : 'repayment-committed';
  // The files are assertion oracles only; restore reads exclusively LevelDB/WAL.
  assert.equal(safeStringify(financialState(env), 2), readFileSync(join(output, `${previous}.json`), 'utf8'));
  if (mode === 'mature') {
    assert.equal(book(env).loan.status, 'active');
    assert.equal(book(env).loan.lateMs, termMs);
    env.state.timestamp = book(env).loan.dueAt + termMs / 2;
    await converge(env, 40);
    assert.equal(book(env).loan.status, 'defaulted');
    assert.equal(book(env).pool.borrowedAmount, 0n);
    assert.equal(book(env).pool.availableAmount, 5_000n);
    // A borrower's default does not erase the bank's independent saver claim.
    await command(env, saver, { type: 'lendingClosePosition', data: {
      hubEntityId: bank.entityId, positionId,
    } });
    assert.equal(book(env).pool.status, 'closed');
    assert.equal(balance(env, saver, bank), 10_050n);
    evidence(env, 'defaulted');
    process.kill(process.pid, 'SIGKILL');
  } else if (mode === 'repay') {
    const { loan } = book(env);
    assert.equal(loan.status, 'defaulted');
    assert.equal(loan.lateMs, termMs);
    await processRuntime(env, [{ ...borrower, entityTxs: [{ type: 'lendingRepay', data: {
      hubEntityId: bank.entityId, loanId: loan.loanId, tokenId: 1,
      // 2,500 principal + 50 term coupon + at most 50 late coupon.
      amount: 2_600n,
    } }] }]);
    for (let round = 0; round < 40 && book(env).loan.status !== 'repaid'; round++) {
      await processRuntime(env);
    }
    assert.equal(book(env).loan.status, 'repaid');
    assert.equal(book(env).loan.repaidAmount, 2_575n);
    assert.equal(book(env).pool.status, 'closed');
    assert((env.runtimeMempool?.entityInputs.length ?? 0) > 0, 'crash must retain a real committed outbox');
    evidence(env, 'repayment-committed');
    process.kill(process.pid, 'SIGKILL');
  } else if (mode === 'interleave') {
    assert.equal(env.infrastructure?.maxEntityInputsPerFrame, 1);
    // The saver's unrelated command owns this frame; the recovered ACK waits
    // behind the cap. A second crash must not turn RAM admission into delivery.
    await processRuntime(env, [{ ...saver, entityTxs: [{ type: 'chat', data: {
      from: saver.signerId, message: 'Recovery frame boundary',
    } }] }]);
    assert(account(env, borrower, bank).pendingFrame);
    assert((env.runtimeMempool?.entityInputs.length ?? 0) > 0);
    evidence(env, 'interleaved');
    process.kill(process.pid, 'SIGKILL');
  } else if (mode === 'recover') {
    assert.equal(book(env).loan.status, 'repaid');
    const redelivery = [...(env.pendingNetworkOutputs ?? [])];
    await converge(env, 40);
    assert(redelivery.length > 0, 'recovery must republish the durable outbox');
    evidence(env, 'recovered');
    const before = balance(env, borrower, bank);
    assert.equal(before, 9_925n);
    assert.equal(balance(env, saver, bank), 10_050n);
    assert.equal(book(env).loan.repaidAmount, 2_575n);
    assert.equal(account(env, bank, borrower).state.subcontracts?.has(book(env).loan.loanId) ?? false, false);
    assert.equal(account(env, borrower, bank).state.subcontracts?.has(book(env).loan.loanId) ?? false, false);
    // Exact authenticated ACK/proposal duplicates retain evidence without money movement.
    const accountsBefore = financialState(env).accounts;
    env.pendingOutputs = redelivery;
    await converge(env, 40);
    assert.deepEqual(financialState(env).accounts, accountsBefore);
    assert.equal(balance(env, borrower, bank), before);
    assert.equal(balance(env, saver, bank), 10_050n);
    assert.equal(book(env).pool.availableAmount, 0n);
    evidence(env, 'redelivered');
    await closeRuntimeDb(env);
    await closeInfraDb(env);
  } else throw new Error(`LENDING_FIXTURE_MODE_INVALID:${mode}`);
}
