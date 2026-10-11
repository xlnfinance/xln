import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeInfraDb, closeRuntimeDb, loadEnvFromDB, processRuntime } from '../../../runtime';
import { converge } from '../../../scenarios/harness/helpers';
import { safeStringify } from '../../../protocol/serialization';
import { computeAccountStateRootCold } from '../../../account/commitment/state-root';
import { assertLendingCovenant, LENDING_YEAR_MS, lendingExitAmount } from '../../../protocol/dispute/lending-covenant';
import type { RuntimeReplica } from '../../../runtime/types';
import { bank, borrower, command, fundedLoan, jurisdiction, positionId, replica, saver, seed, termMs } from './lending-runtime';

const mode = process.argv[2];
const output = process.env['XLN_DB_PATH'];
if (!output) throw new Error('LENDING_FIXTURE_DB_PATH_REQUIRED');

function book(env: RuntimeReplica) {
  const state = replica(env, bank).state.lending;
  assert(state);
  const loan = [...state.loans.values()][0];
  const pool = state.savings.get(positionId);
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

if (mode === 'originate' || mode === 'demand-originate') {
  const env = await fundedLoan(mode === 'demand-originate' ? 'demand' : '1h');
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
  const previous = mode === 'demand-rate' ? 'active' : mode === 'demand-close' ? 'demand-rate' : mode === 'demand-recover' ? 'demand-queued' : mode === 'partial' || mode === 'early-close' ? 'active' : mode === 'early-recover' ? 'early-queued' : mode === 'mature' ? 'partial' : mode === 'withdraw' ? 'queued' : mode === 'repay' ? 'defaulted'
    : mode === 'recover' ? 'interleaved' : 'repayment-committed';
  // The files are assertion oracles only; restore reads exclusively LevelDB/WAL.
  assert.equal(safeStringify(financialState(env), 2), readFileSync(join(output, `${previous}.json`), 'utf8'));
  if (mode === 'demand-rate') {
    const opened = book(env).pool.createdAt;
    env.state.timestamp = opened + LENDING_YEAR_MS / 4 + 1;
    await command(env, bank, { type: 'lendingSetTerms', data: {
      chainId: jurisdiction.chainId, depositoryAddress: jurisdiction.depositoryAddress,
      tokenId: 1, termId: 'demand', savingsInterestBps: 200, loanInterestBps: 0, loanLateMs: 0,
      expiresAt: env.state.timestamp + 2 * LENDING_YEAR_MS,
    } });
    const claim = account(env, bank, saver).state.subcontracts?.get(positionId);
    assertLendingCovenant(claim);
    assert.equal(claim.kind, 'demand');
    assert.equal(claim.interestBps, 200);
    assert.equal(claim.accruedInterest, 62n);
    assert(claim.interestRemainder > 0n);
    assert.equal(book(env).pool.interestBps, 200);
    assert.deepEqual(claim, account(env, saver, bank).state.subcontracts?.get(positionId));
    evidence(env, 'demand-rate');
    process.kill(process.pid, 'SIGKILL');
  } else if (mode === 'demand-close') {
    env.state.timestamp = book(env).pool.createdAt + LENDING_YEAR_MS / 2;
    await command(env, saver, { type: 'extendCredit', data: {
      counterpartyEntityId: bank.entityId, tokenId: 1, amount: 5_000n,
    } });
    await command(env, saver, { type: 'lendingClosePosition', data: { hubEntityId: bank.entityId, positionId } });
    assert.equal(book(env).pool.status, 'queued');
    const claim = account(env, saver, bank).state.subcontracts?.get(positionId);
    assertLendingCovenant(claim);
    assert.equal(lendingExitAmount(claim, env.state.timestamp), 5_087n);
    evidence(env, 'demand-queued');
    process.kill(process.pid, 'SIGKILL');
  } else if (mode === 'demand-recover') {
    assert.equal(book(env).pool.status, 'queued');
    env.state.timestamp = book(env).pool.createdAt + 3 * LENDING_YEAR_MS / 4;
    await command(env, saver, { type: 'extendCredit', data: {
      counterpartyEntityId: bank.entityId, tokenId: 1, amount: 100_000n,
    } });
    assert.equal(book(env).pool.status, 'closed');
    assert.equal(balance(env, saver, bank), 10_112n);
    assert.equal(account(env, saver, bank).state.subcontracts?.has(positionId), false);
    assert.equal(account(env, bank, saver).state.subcontracts?.has(positionId), false);
    assert(!account(env, saver, bank).pendingFrame && !account(env, bank, saver).pendingFrame);
    evidence(env, 'demand-paid');
    await closeRuntimeDb(env);
    await closeInfraDb(env);
  } else if (mode === 'early-close') {
    const maturity = book(env).pool.createdAt + termMs;
    env.state.timestamp = maturity - 1_000;
    await processRuntime(env, [{ ...saver, entityTxs: [{ type: 'lendingClosePosition', data: {
      hubEntityId: bank.entityId, positionId,
    } }] }]);
    const signed = account(env, saver, bank).pendingFrame;
    assert(signed && signed.timestamp < maturity);
    assert(signed.accountTxs.some(tx => tx.type === 'lending_close_request'));
    // Deliver the signed request after maturity through the real Runtime inbox.
    // The bank must preserve the Account quote even though its own clock is later.
    env.state.timestamp = maturity + 60_000;
    for (let round = 0; round < 40 && book(env).pool.status === 'open'; round++) await processRuntime(env);
    assert.equal(book(env).pool.status, 'queued');
    assert.equal(book(env).pool.updatedAt, signed.timestamp);
    assert.equal(book(env).pool.closeOrder, 1);
    evidence(env, 'early-queued');
    process.kill(process.pid, 'SIGKILL');
  } else if (mode === 'early-recover') {
    assert.equal(book(env).pool.status, 'queued');
    assert(book(env).pool.updatedAt < book(env).pool.createdAt + termMs);
    await converge(env, 40);
    assert.equal(book(env).pool.status, 'closed');
    assert.equal(balance(env, saver, bank), 10_000n);
    assert.equal(account(env, saver, bank).state.subcontracts?.has(positionId), false);
    assert.equal(account(env, bank, saver).state.subcontracts?.has(positionId), false);
    assert(!account(env, saver, bank).pendingFrame);
    assert(!account(env, bank, saver).pendingFrame);
    evidence(env, 'early-paid');
    await closeRuntimeDb(env);
    await closeInfraDb(env);
  } else if (mode === 'partial') {
    const { loan } = book(env);
    env.state.timestamp = loan.openedAt + termMs / 2 + 1;
    await command(env, borrower, { type: 'lendingRepay', data: {
      hubEntityId: bank.entityId, loanId: loan.loanId, tokenId: 1, amount: 1_025n,
    } });
    const remaining = book(env).loan;
    assert.equal(remaining.status, 'active');
    assert.equal(remaining.principalAmount, 1_500n);
    assert.equal(remaining.repaidAmount, 1_025n);
    assert.equal(remaining.accruedInterest, 0n);
    assert.equal(remaining.interestRemainder,
      2_500n * 200n * BigInt(remaining.accruedAt - remaining.openedAt) % (10_000n * BigInt(termMs)));
    assert(remaining.interestRemainder > 0n, 'the crash must preserve fractional interest');
    for (const party of [bank, borrower]) {
      const claim: unknown = account(env, party, party === bank ? borrower : bank).state.subcontracts?.get(loan.loanId);
      assertLendingCovenant(claim);
      assert.equal(claim.principal, remaining.principalAmount);
      assert.equal(claim.interestRemainder, remaining.interestRemainder);
    }
    evidence(env, 'partial');
    process.kill(process.pid, 'SIGKILL');
  } else if (mode === 'mature') {
    assert.equal(book(env).loan.status, 'active');
    assert.equal(book(env).loan.lateMs, termMs);
    env.state.timestamp = book(env).loan.dueAt + termMs / 2;
    await converge(env, 40);
    assert.equal(book(env).loan.status, 'defaulted');
    assert.equal(book(env).pool.principalAmount, 5_000n);
    assert.equal(book(env).pool.status, 'open');
    await command(env, saver, { type: 'extendCredit', data: {
      counterpartyEntityId: bank.entityId, tokenId: 1, amount: 5_000n,
    } });
    // A borrower's default does not erase the bank's independent saver claim.
    await command(env, saver, { type: 'lendingClosePosition', data: {
      hubEntityId: bank.entityId, positionId,
    } });
    assert.equal(book(env).pool.status, 'queued');
    assert.equal(book(env).pool.closeOrder, 1);
    assert.equal(balance(env, saver, bank), 5_000n);
    evidence(env, 'queued');
    process.kill(process.pid, 'SIGKILL');
  } else if (mode === 'withdraw') {
    assert.equal(book(env).pool.status, 'queued');
    assert.equal(book(env).pool.closeOrder, 1);
    // Liquidity returns after SIGKILL. No new withdrawal request, timer or
    // sidecar queue may be necessary to settle the retained bank liability.
    await command(env, saver, { type: 'extendCredit', data: {
      counterpartyEntityId: bank.entityId, tokenId: 1, amount: 100_000n,
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
      // The Account caps this authorization at the remaining debt. Earlier
      // payments reduced principal; accrued fractions survived SIGKILL.
      amount: 2_600n,
    } }] }]);
    for (let round = 0; round < 40 && book(env).loan.status !== 'repaid'; round++) {
      await processRuntime(env);
    }
    assert.equal(book(env).loan.status, 'repaid');
    assert.equal(book(env).loan.repaidAmount, 2_555n);
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
    assert.equal(before, 9_945n);
    assert.equal(balance(env, saver, bank), 10_050n);
    assert.equal(book(env).loan.repaidAmount, 2_555n);
    assert.equal(account(env, bank, borrower).state.subcontracts?.has(book(env).loan.loanId) ?? false, false);
    assert.equal(account(env, borrower, bank).state.subcontracts?.has(book(env).loan.loanId) ?? false, false);
    // Exact authenticated ACK/proposal duplicates retain evidence without money movement.
    const accountsBefore = financialState(env).accounts;
    env.pendingOutputs = redelivery;
    await converge(env, 40);
    assert.deepEqual(financialState(env).accounts, accountsBefore);
    assert.equal(balance(env, borrower, bank), before);
    assert.equal(balance(env, saver, bank), 10_050n);
    assert.equal(book(env).pool.status, 'closed');
    evidence(env, 'redelivered');
    await closeRuntimeDb(env);
    await closeInfraDb(env);
  } else throw new Error(`LENDING_FIXTURE_MODE_INVALID:${mode}`);
}
