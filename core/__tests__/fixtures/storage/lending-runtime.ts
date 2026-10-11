import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { defaultAccountDisputeConfigForParties } from '../../../account/config/dispute-config';
import { generateLazyEntityId } from '../../../entity/factory';
import { deriveAccountWatchSeed } from '../../../protocol/identity/account-watch-seed';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';
import { commitRuntimeInput, converge } from '../../../scenarios/harness/helpers';
import { createEmptyEnv, processRuntime } from '../../../runtime';
import type { RuntimeReplica } from '../../../runtime/types';
import type { EntityTx } from '../../../types/entity-tx';

export const seed = 'lending-runtime-real-crash-20261011';
export const parties = [1, 2, 3].map(slot => {
  const signerId = deriveSignerAddressSync(seed, String(slot)).toLowerCase();
  registerSignerKey(seed, signerId, deriveSignerKeySync(seed, String(slot)));
  return { signerId, entityId: generateLazyEntityId([signerId], 1n).toLowerCase() };
});
export const bank = parties[0]!;
export const saver = parties[1]!;
export const borrower = parties[2]!;
export const positionId = 'lend-1111111111111111';
export const requestId = 'borrow-2222222222222222';
export const termMs = 3_600_000;
export const jurisdiction = {
  name: 'lending-recovery', address: 'browservm://lending-recovery', chainId: 31337,
  depositoryAddress: '0x000000000000000000000000000000000000dead',
  entityProviderAddress: '0x000000000000000000000000000000000000beef',
};

export function replica(env: RuntimeReplica, party: typeof bank) {
  const value = env.state.eReplicas.get(`${party.entityId}:${party.signerId}`);
  if (!value) throw new Error(`LENDING_FIXTURE_REPLICA_MISSING:${party.entityId}`);
  return value;
}

export async function command(env: RuntimeReplica, party: typeof bank, tx: EntityTx) {
  await processRuntime(env, [{ ...party, entityTxs: [tx] }]);
  await converge(env, 40);
}

/** All financial state comes from committed Runtime -> Entity -> Account inputs.
 * Initial balances are explicit bank IOUs within the saver/borrower's signed
 * credit limits, not fabricated collateral or a claim of on-chain funding.
 */
export async function fundedLoan(savingsTerm: '1h' | 'demand' = '1h'): Promise<RuntimeReplica> {
  const env = createEmptyEnv(seed);
  env.runtimeId = bank.signerId;
  env.dbNamespace = bank.signerId;
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  if (!env.infrastructure) throw new Error('LENDING_FIXTURE_INFRASTRUCTURE_MISSING');
  env.infrastructure.maxEntityInputsPerFrame = 1;
  env.state.timestamp = 1_000;
  env.runtimeConfig = { ...env.runtimeConfig, storage: {
    enabled: true, snapshotPeriodFrames: 256, retainSnapshots: 3,
    epochMaxBytes: 100_000_000, materializePeriodFrames: 100,
    canonicalHashPeriodFrames: 1, accountMerkleRadix: 16,
  } };
  env.activeJurisdiction = jurisdiction.name;
  env.state.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name, chainId: jurisdiction.chainId, blockNumber: 0n,
    stateRoot: new Uint8Array(32), mempool: [], blockDelayMs: 0,
    lastBlockTimestamp: 1_000, position: { x: 0, y: 0, z: 0 },
    contracts: {
      account: '0x000000000000000000000000000000000000ac01',
      depository: jurisdiction.depositoryAddress, entityProvider: jurisdiction.entityProviderAddress,
      deltaTransformer: '0x000000000000000000000000000000000000de17',
    },
  });
  await commitRuntimeInput(env, {
    runtimeTxs: parties.map(party => createTestEntityImportRuntimeTx(env, { ...party, data: {
      isProposer: true, position: { x: 0, y: 0, z: 0 }, config: {
        mode: 'proposer-based', threshold: 1n, validators: [party.signerId],
        shares: { [party.signerId]: 1n }, jurisdiction,
      },
    } })), entityInputs: [],
  });
  for (const user of [saver, borrower]) {
    const watchSeed = deriveAccountWatchSeed({ runtimeSeed: seed, runtimeId: bank.signerId,
      entityId: bank.entityId, counterpartyId: user.entityId });
    await processRuntime(env, [bank, user].map(party => {
      const peer = party === bank ? user : bank;
      return { ...party, entityTxs: [{ type: 'openAccount' as const, data: {
        targetEntityId: peer.entityId, tokenId: 1, creditAmount: 100_000n, watchSeed,
        disputeConfig: defaultAccountDisputeConfigForParties(party.entityId, false, peer.entityId, false),
      } }] };
    }));
    await converge(env, 40);
    await command(env, bank, { type: 'directPayment', data: {
      targetEntityId: user.entityId, tokenId: 1, amount: 10_000n,
      route: [bank.entityId, user.entityId], deliveryMode: 'direct',
    } });
  }
  await command(env, bank, { type: 'setHubConfig', data: {} });
  const expiresAt = env.state.timestamp + 10 * termMs;
  await command(env, bank, { type: 'lendingSetTerms', data: {
    chainId: jurisdiction.chainId, depositoryAddress: jurisdiction.depositoryAddress,
    tokenId: 1, termId: '1h', savingsInterestBps: 100, loanInterestBps: 200,
    loanLateMs: termMs, expiresAt,
  } });
  await command(env, bank, { type: 'lendingApprove', data: {
    borrowerEntityId: borrower.entityId, tokenId: 1, termId: '1h', maxPrincipal: 2_500n, expiresAt,
  } });
  if (savingsTerm === 'demand') await command(env, bank, { type: 'lendingSetTerms', data: {
    chainId: jurisdiction.chainId, depositoryAddress: jurisdiction.depositoryAddress,
    tokenId: 1, termId: 'demand', savingsInterestBps: 500, loanInterestBps: 0, loanLateMs: 0,
    expiresAt: env.state.timestamp + 2 * 365 * 24 * 60 * 60 * 1000,
  } });
  await command(env, saver, { type: 'lendingOffer', data: {
    positionId, hubEntityId: bank.entityId, tokenId: 1, amount: 5_000n, termId: savingsTerm, interestBps: savingsTerm === 'demand' ? 500 : 100,
  } });
  await command(env, borrower, { type: 'lendingBorrow', data: {
    requestId, hubEntityId: bank.entityId, tokenId: 1, amount: 2_500n, termId: '1h',
    maxInterestBps: 200, maxLateMs: termMs, expiresAt: env.state.timestamp + 300_000,
  } });
  return env;
}
