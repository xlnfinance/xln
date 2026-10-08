import { expect, test } from 'bun:test';
import { closeRuntimeDb, createEmptyEnv } from '../../../runtime';
import { TsAccountWorkerAuthority } from '../../../rscore/ts-worker';
import { createJReplica } from '../../../scenarios/harness/boot';
import { entity, makeAccount, makeJurisdiction, makeState, openWritableEntityAccounts } from '../../helpers/cross-j';

test('Runtime close releases its Account workers but borrowed replay close preserves the live executor', async () => {
  const owner = entity('11');
  const counterparty = entity('22');
  const signer = `0x${'44'.repeat(20)}`;
  const jurisdiction = makeJurisdiction('worker-runtime-close', 31_337, '55', '66');
  const state = makeState(owner, signer, jurisdiction);
  openWritableEntityAccounts(state).set(counterparty, makeAccount(owner, counterparty, jurisdiction));
  const env = createEmptyEnv('worker-runtime-close');
  const jReplica = createJReplica(env, jurisdiction.name, jurisdiction.depositoryAddress);
  jReplica.chainId = jurisdiction.chainId;
  const authority = new TsAccountWorkerAuthority(env, 1);
  env.accountAuthorityEntityStageProvider = authority.provider;
  env.accountAuthorityExecutionMode = 'cutover';
  const common = {
    ownerEntityId: owner,
    ownerSignerId: signer,
    unsupportedEntityTxTypes: [],
    occurrence: { kind: 'runtime-input' as const, inputIndex: 0 },
    deferProposal: false,
  };
  const execute = () => authority.provider.executeAccountInboundBatch({
    ...common,
    expectedAccountsRoot: state.accounts.rootHash(),
    entityState: state,
    entityContext: undefined,
    requests: [],
  });
  try {
    await execute();
    expect((await authority.telemetry()).initializedAccounts).toBe(1);
    const borrowed = createEmptyEnv('worker-runtime-close-borrowed');
    borrowed.infrastructure = { ...borrowed.infrastructure, runtimeWalDbBorrowed: true };
    borrowed.accountAuthorityEntityStageProvider = authority.provider;
    borrowed.accountAuthorityExecutionMode = 'cutover';
    await closeRuntimeDb(borrowed);
    expect(borrowed.accountAuthorityEntityStageProvider).toBe(authority.provider);
    expect((await authority.telemetry()).initializedAccounts).toBe(1);
    await authority.provider.discardEntityFrameAttempt(common);
    await execute();
    await authority.provider.discardEntityFrameAttempt(common);
    await closeRuntimeDb(env);
    expect(env.accountAuthorityEntityStageProvider).toBeUndefined();
    expect(env.accountAuthorityExecutionMode).toBeUndefined();
    expect((await authority.telemetry()).initializedAccounts).toBe(0);
    await closeRuntimeDb(env);
  } finally {
    await authority.close();
  }
});
