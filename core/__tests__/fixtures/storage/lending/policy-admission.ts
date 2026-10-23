import { strict as assert } from 'node:assert';
import { bank, borrower, command, fundedLoan, jurisdiction, replica, seed, termMs } from '../lending-runtime';
import { closeInfraDb, closeRuntimeDb, loadEnvFromDB, processRuntime } from '../../../../runtime';
import { converge } from '../../../../scenarios/harness/helpers';
import { safeStringify } from '../../../../protocol/serialization';
import { computeAccountStateRootCold } from '../../../../account/commitment/state-root';
import { computeCanonicalStateHashFromEnv } from '../../../../storage/canonical-hash';
import { registerStructuredLogSink } from '../../../../support/logger';
import type { EntityTx } from '../../../../types/entity-tx';

assert(process.env['XLN_DB_PATH'], 'ISOLATED_LENDING_DB_REQUIRED');
const env = await fundedLoan();
let restored: Awaited<ReturnType<typeof loadEnvFromDB>> = null;
const logs: string[] = [];
const unsubscribe = registerStructuredLogSink(event => {
  if (event.message === 'entity_input.batch_tx_evicted') logs.push(String(event['rejection']));
});
const terms = {
  chainId: jurisdiction.chainId,
  depositoryAddress: jurisdiction.depositoryAddress,
  tokenId: 1,
  termId: '1h' as const,
  savingsInterestBps: 100,
  loanInterestBps: 200,
  loanLateMs: termMs,
  expiresAt: env.state.timestamp + 10 * termMs,
};
const injectedFacility = {
  borrowerEntityId: borrower.entityId,
  tokenId: 1,
  termId: '1h' as const,
  maxPrincipal: 2_500n,
  expiresAt: terms.expiresAt,
  chainId: 31338,
  depositoryAddress: `0x${'44'.repeat(20)}`,
  jNonce: 99,
};
const extraEnvelope = { type: 'lendingSetTerms' as const, data: terms, untrustedExtra: true };
const invalid: EntityTx[] = [
  { type: 'lendingSetTerms', data: { ...terms, depositoryAddress: `0x${'DD'.repeat(20)}` } },
  { type: 'lendingSetTerms', data: { ...terms, savingsInterestBps: -1 } },
  { type: 'lendingSetTerms', data: { ...terms, expiresAt: Number.MAX_SAFE_INTEGER } },
  {
    type: 'lendingApprove',
    data: {
      borrowerEntityId: borrower.entityId,
      tokenId: 1,
      termId: 'demand',
      maxPrincipal: 2_500n,
      expiresAt: terms.expiresAt,
    },
  },
  {
    type: 'lendingApprove',
    data: {
      borrowerEntityId: borrower.entityId,
      tokenId: 1,
      termId: '1h',
      maxPrincipal: -1n,
      expiresAt: terms.expiresAt,
    },
  },
  {
    type: 'lendingApprove',
    data: { borrowerEntityId: borrower.entityId, tokenId: 1, termId: '1h', maxPrincipal: 2_500n, expiresAt: -1 },
  },
  { type: 'lendingApprove', data: injectedFacility },
  extraEnvelope,
];
const financial = () =>
  safeStringify({
    book: replica(env, bank).state.lending,
    accounts: [...env.state.eReplicas.values()].flatMap(replica =>
      [...replica.state.accounts.values()].map(account => computeAccountStateRootCold(account.state)),
    ),
  });
try {
  const before = financial();
  for (const [index, tx] of invalid.entries()) {
    const name = `Live after rejected bank policy ${index}`;
    // Each envelope becomes one independently signed Entity command. Reject
    // the invalid command atomically while retaining its healthy successor.
    await processRuntime(env, [
      { ...bank, entityTxs: [tx] },
      { ...bank, entityTxs: [{ type: 'profile-update', data: { profile: { entityId: bank.entityId, name } } }] },
    ]);
    await converge(env, 40);
    assert.equal(financial(), before, `invalid bank policy ${index} cannot change obligations or authority`);
    assert.equal(replica(env, bank).state.profile.name, name, 'evict one bad tx, retain its healthy signer queue');
    assert.notEqual(env.infrastructure?.halted, true);
    assert.equal(replica(env, bank).mempool.length, 0);
  }
  const rejections = [
    'LENDING_POLICY_DOMAIN_INVALID',
    'LENDING_POLICY_INPUT_DATA_SAVINGSINTERESTBPS:-1',
    'LENDING_POLICY_CLOCK_OVERFLOW:9007199261940992',
    'LENDING_POLICY_INPUT_DATA_TERMID_VALUE',
    'LENDING_FACILITY_AMOUNT_INVALID',
    'LENDING_POLICY_INPUT_DATA_EXPIRESAT:-1',
    'LENDING_POLICY_INPUT_DATA_FIELDS:missing=none:extra=chainId,depositoryAddress,jNonce',
    'LENDING_POLICY_INPUT_FIELDS:missing=none:extra=untrustedExtra',
  ];
  assert.deepEqual(
    logs,
    rejections.map((rejection, index) => {
      const tx = invalid[index];
      assert(tx);
      return `ENTITY_FRAME_TX_FAILED: type=${tx.type} error=${rejection}`;
    }),
  );
  await command(env, bank, { type: 'lendingSetTerms', data: terms });
  const expected = computeCanonicalStateHashFromEnv(env);
  await closeRuntimeDb(env);
  await closeInfraDb(env);
  restored = await loadEnvFromDB(bank.signerId, seed);
  assert(restored);
  assert.equal(computeCanonicalStateHashFromEnv(restored), expected);
  console.log('LENDING_POLICY_REJECTION_WAL_GREEN:rejected=8:healthy=8:recovery=exact');
} finally {
  unsubscribe();
  for (const runtime of new Set([env, restored]))
    if (runtime) {
      await closeRuntimeDb(runtime);
      await closeInfraDb(runtime);
    }
}
