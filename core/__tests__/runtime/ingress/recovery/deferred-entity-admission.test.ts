import { expect, test } from 'bun:test';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../../account/crypto';
import { generateLazyEntityId } from '../../../../entity/factory';
import { prepareLocallyAuthoredEntityTxs } from '../../../../entity/command';
import { applyEntityTx } from '../../../../entity/tx/apply';
import { createTestEntityImportRuntimeTx } from '../../../../qa/entity-creation-fixture';
import { closeInfraDb, closeRuntimeDb, createEmptyEnv, processRuntime } from '../../../../runtime';
import { commitRuntimeInput, converge } from '../../../../scenarios/harness/helpers';
import { safeStringify } from '../../../../protocol/serialization';
import { registerStructuredLogSink, type StructuredLogEvent } from '../../../../support/logger';
import type { EntityTx } from '../../../../types/entity-tx';
import { createTestJReplica } from '../../../helpers/j-replica';

const jurisdiction = {
  name: 'DeferredAdmission',
  address: 'browservm://deferred-admission',
  chainId: 31337,
  depositoryAddress: `0x${'41'.repeat(20)}`,
  entityProviderAddress: `0x${'42'.repeat(20)}`,
};
const peer = `0x${'53'.repeat(32)}`;
const commands: EntityTx[] = [
  {
    type: 'lendingSetTerms',
    data: {
      chainId: jurisdiction.chainId,
      depositoryAddress: jurisdiction.depositoryAddress,
      tokenId: 1,
      termId: '1h',
      savingsInterestBps: 100,
      loanInterestBps: 200,
      loanLateMs: 3_600_000,
      expiresAt: 10_000_000,
    },
  },
  {
    type: 'lendingApprove',
    data: {
      borrowerEntityId: peer,
      tokenId: 1,
      termId: '1h',
      maxPrincipal: 2_500n,
      expiresAt: 10_000_000,
    },
  },
  {
    type: 'lendingOffer',
    data: {
      positionId: 'lend-1111111111111111',
      hubEntityId: peer,
      tokenId: 1,
      amount: 5_000n,
      termId: '1h',
      interestBps: 100,
    },
  },
  {
    type: 'lendingBorrow',
    data: {
      requestId: 'borrow-2222222222222222',
      hubEntityId: peer,
      tokenId: 1,
      amount: 2_500n,
      termId: '1h',
      maxInterestBps: 200,
      maxLateMs: 3_600_000,
      expiresAt: 10_000_000,
    },
  },
  { type: 'lendingRepay', data: { hubEntityId: peer, loanId: 'loan-3333333333333333', tokenId: 1, amount: 1n } },
  { type: 'lendingClosePosition', data: { hubEntityId: peer, positionId: 'lend-1111111111111111' } },
];

test.each(['0', '1'])(
  'deferred Entity commands preserve the same signer queue (fail-fast=%s)',
  async policy => {
    const seed = `deferred-entity-admission-runtime-${policy}`;
    const env = createEmptyEnv(seed);
    const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
    registerSignerKey(seed, signerId, deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    env.runtimeId = signerId;
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.state.timestamp = 1_000;
    env.runtimeConfig = { ...env.runtimeConfig, storage: { ...env.runtimeConfig.storage, enabled: false } };
    env.activeJurisdiction = jurisdiction.name;
    env.state.jReplicas.set(
      jurisdiction.name,
      createTestJReplica({
        name: jurisdiction.name,
        chainId: jurisdiction.chainId,
        contracts: {
          account: `0x${'43'.repeat(20)}`,
          depository: jurisdiction.depositoryAddress,
          entityProvider: jurisdiction.entityProviderAddress,
          deltaTransformer: `0x${'44'.repeat(20)}`,
        },
      }),
    );
    const previousPolicy = process.env['XLN_REJECT_FAIL_FAST'];
    process.env['XLN_REJECT_FAIL_FAST'] = policy;
    const logs: StructuredLogEvent[] = [];
    const unsubscribe = registerStructuredLogSink(event => {
      if (event.scope === 'runtime.entity_inputs') logs.push(event);
    });
    const current = () => {
      const replica = env.state.eReplicas.get(`${entityId}:${signerId}`);
      if (!replica) throw new Error('DEFERRED_ADMISSION_REPLICA_MISSING');
      return replica;
    };
    try {
      await commitRuntimeInput(env, {
        runtimeTxs: [
          createTestEntityImportRuntimeTx(env, {
            entityId,
            signerId,
            data: {
              isProposer: true,
              position: { x: 0, y: 0, z: 0 },
              config: {
                mode: 'proposer-based',
                threshold: 1n,
                validators: [signerId],
                shares: { [signerId]: 1n },
                jurisdiction,
              },
            },
          }),
        ],
        entityInputs: [],
      });
      await processRuntime(env, [{ entityId, signerId, entityTxs: [{ type: 'setHubConfig', data: {} }] }]);
      await converge(env, 10);

      const state = current().state;
      const before = safeStringify(state);
      for (const tx of commands) {
        const result = await applyEntityTx(env, state, tx, { mutableFrameState: true });
        expect(result.skippedError).toBe(`ENTITY_TX_KIND_OUT_OF_PROFILE:${tx.type}`);
        expect(result.newState).toBe(state);
        expect(result.outputs).toEqual([]);
        expect(result.storageChanges).toEqual([]);
        expect(result.candidateEffects).toEqual([]);
        expect(result.accountTxs).toBeUndefined();
        expect(safeStringify(state)).toBe(before);
      }

      // Raw inputs from the same signer are merged and signed during admission.
      // A deferred command must be rejected before that merge; it must neither
      // mutate the Lendbook nor erase the legitimate commands around it.
      const queue: EntityTx[] = [
        { type: 'profile-update', data: { profile: { entityId, name: 'Preserved before rejection' } } },
        ...commands,
        { type: 'setHubConfig', data: { baseFee: 99n } },
      ];
      const applied = processRuntime(
        env,
        queue.map(tx => ({ entityId, signerId, entityTxs: [tx] })),
      );
      if (policy === '1') await expect(applied).rejects.toThrow('REMOTE_INPUT_REJECTED');
      else await applied;
      await converge(env, 20);
      expect(env.infrastructure?.halted).not.toBe(true);
      expect(current().mempool).toHaveLength(0);
      expect(current().state.accounts.size).toBe(0);
      expect(current().state.lending).toBeUndefined();
      expect(current().state.profile.name).toBe('Preserved before rejection');
      expect(current().state.hubRebalanceConfig?.baseFee).toBe(99n);
    const rejected = logs.filter(event => event.message === 'entity_input.rejected');
      expect(rejected.map(event => event['rejectionCode'])).toEqual(
        commands.map(tx => `ENTITY_TX_KIND_OUT_OF_PROFILE:${tx.type}`),
      );
      const signed = prepareLocallyAuthoredEntityTxs(env, current().state, signerId, [commands[2]!])[0];
      if (!signed) throw new Error('DEFERRED_ADMISSION_SIGNED_COMMAND_MISSING');
      const signedBytes = safeStringify(signed);
      await processRuntime(env, [{ entityId, signerId, entityTxs: [signed] }]);
      await converge(env, 10);
      expect(safeStringify(signed)).toBe(signedBytes);
      expect(current().state.lending).toBeUndefined();
      expect(
        logs.filter(event => event.message === 'entity_input.batch_tx_evicted').map(event => event['rejection']),
      ).toEqual(['ENTITY_TX_KIND_OUT_OF_PROFILE:lendingOffer']);
      const height = env.state.height;
      await processRuntime(env, [
        { entityId, signerId, entityTxs: [{ type: 'setHubConfig', data: { baseFee: 100n } }] },
      ]);
      await converge(env, 10);
      expect(env.state.height).toBeGreaterThan(height);
      expect(current().state.hubRebalanceConfig?.baseFee).toBe(100n);
    } finally {
      unsubscribe();
      if (previousPolicy === undefined) delete process.env['XLN_REJECT_FAIL_FAST'];
      else process.env['XLN_REJECT_FAIL_FAST'] = previousPolicy;
      await closeRuntimeDb(env);
      await closeInfraDb(env);
    }
  },
  30_000,
);
