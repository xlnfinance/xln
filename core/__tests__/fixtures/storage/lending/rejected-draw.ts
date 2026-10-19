import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bank, borrower, command, fundedLoan, replica, seed, termMs } from '../lending-runtime';
import { closeRuntimeDb, closeInfraDb, loadEnvFromDB, processRuntime } from '../../../../runtime';
import { converge } from '../../../../scenarios/harness/helpers';
import { safeStringify } from '../../../../protocol/serialization';
import { computeAccountStateRootCold } from '../../../../account/commitment/state-root';
import type { RuntimeReplica } from '../../../../runtime/types';

const dbRoot = process.env['XLN_DB_PATH'];
if (!dbRoot) throw new Error('ISOLATED_LENDING_DB_REQUIRED');
const requestId = 'borrow-3333333333333333';
const mode = process.argv[2];
if (mode !== 'originate' && mode !== 'recover') throw new Error('LENDING_REJECTED_DRAW_MODE');
const env = mode === 'originate' ? await fundedLoan() : await loadEnvFromDB(bank.signerId, seed);
assert(env);
env.scenarioMode = true;
env.quietRuntimeLogs = true;

function account(runtime: RuntimeReplica) {
  const value = replica(runtime, bank).state.accounts.get(borrower.entityId);
  assert(value);
  return value;
}
function evidence(runtime: RuntimeReplica) {
  return safeStringify({
    height: runtime.state.height,
    book: replica(runtime, bank).state.lending,
    root: computeAccountStateRootCold(account(runtime).state),
  });
}
function borrow(runtime: RuntimeReplica, id: string) {
  return {
    type: 'lendingBorrow' as const,
    data: {
      requestId: id,
      hubEntityId: bank.entityId,
      tokenId: 1,
      amount: 150_000n,
      termId: '1h' as const,
      maxInterestBps: 200,
      maxLateMs: termMs,
      expiresAt: runtime.state.timestamp + 300_000,
    },
  };
}
try {
  if (mode === 'originate') {
    await command(env, bank, {
      type: 'lendingApprove',
      data: {
        borrowerEntityId: borrower.entityId,
        tokenId: 1,
        termId: '1h',
        maxPrincipal: 200_000n,
        expiresAt: env.state.timestamp + 10 * termMs,
      },
    });
    const before = account(env).state.deltas.get(1);
    assert(before);
    const beforeDelta = safeStringify(before);
    await command(env, borrower, borrow(env, requestId));
    assert.equal(safeStringify(account(env).state.deltas.get(1)), beforeDelta);
    assert.equal(account(env).state.subcontracts?.size, 1);
    assert.equal(Boolean(account(env).pendingFrame), false);
    assert.equal(account(env).mempool.length, 0);
    const lending = replica(env, bank).state.lending;
    assert(lending);
    assert.equal([...lending.loans.values()].filter(loan => loan.requestId === requestId).length, 0);
    assert.notEqual(env.infrastructure?.halted, true);
    writeFileSync(join(dbRoot, 'rejected.json'), evidence(env));
    console.log('LENDING_REJECTED_DRAW_DURABLE');
    process.kill(process.pid, 'SIGKILL');
  } else {
    // The JSON is an assertion oracle only. Restore uses current checkpoint/WAL.
    assert.equal(evidence(env), readFileSync(join(dbRoot, 'rejected.json'), 'utf8'));
    await command(env, borrower, {
      type: 'extendCredit',
      data: {
        counterpartyEntityId: bank.entityId,
        tokenId: 1,
        amount: 200_000n,
      },
    });
    const nextId = 'borrow-4444444444444444';
    await processRuntime(env, [{ ...borrower, entityTxs: [borrow(env, nextId)] }]);
    for (let round = 0; round < 40; round++) {
      if (
        account(env).pendingFrame?.accountTxs.some(tx => tx.type === 'lending_disburse' && tx.data.requestId === nextId)
      )
        break;
      await processRuntime(env);
    }
    const pending = account(env).pendingFrame;
    assert(pending);
    const signedDraw = pending.accountTxs.find(tx => tx.type === 'lending_disburse' && tx.data.requestId === nextId);
    assert(signedDraw && signedDraw.type === 'lending_disburse');
    const loan = replica(env, bank).state.lending?.loans.get(signedDraw.data.loanId);
    assert(loan);
    assert.equal(loan.status, 'opening');
    assert.equal(loan.principalAmount, 150_000n);
    await converge(env, 40);
    const funded = replica(env, bank).state.lending?.loans.get(signedDraw.data.loanId);
    assert.equal(funded?.status, 'active');
    assert.equal(account(env).state.subcontracts?.size, 2);
    const delta = account(env).state.deltas.get(1);
    assert(delta);
    assert.equal(account(env).state.leftEntity === borrower.entityId ? delta.offdelta : -delta.offdelta, 162_500n);
    const beforeDuplicate = safeStringify(replica(env, bank).state.lending);
    const beforeBalance = delta.offdelta;
    await command(env, borrower, borrow(env, nextId));
    assert.equal(account(env).state.deltas.get(1)?.offdelta, beforeBalance);
    assert.equal(replica(env, bank).state.lending?.loans.size, 2);
    assert.notEqual(env.infrastructure?.halted, true);
    assert.equal(safeStringify(replica(env, bank).state.lending), beforeDuplicate);
    console.log('LENDING_REJECTED_DRAW_RECOVERY_GREEN');
  }
} finally {
  await closeRuntimeDb(env);
  await closeInfraDb(env);
}
