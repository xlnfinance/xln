import { describe, expect, test } from 'bun:test';

import { applyAccountInput } from '../../../account/consensus';
import { proposeAccountFrame } from '../../../account/consensus/proposal/propose';
import { accountInputApplied, proposeAccountFrameIdle } from '../../../account/consensus/result';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { applyEntityInput } from '../../../entity/consensus';
import type { EntityInput } from '../../../entity/types';
import {
  createAccountAuthorityEntityStage,
  resolveAccountAuthorityEntityStageOptions,
  runAccountAuthorityEntityStage,
  type AccountAuthorityEntityStage,
  type AccountAuthorityEntityStageBegin,
  type AccountAuthorityEntityStageOptions,
  type AccountAuthorityEntityStageProvider,
} from '../../../rscore/authority/entity-stage';
import { createEmptyEnv } from '../../../runtime';
import { makeAccount } from '../../helpers/cross-j';
import { createEntityProposalFixture } from '../../helpers/entity-proposal-fixture';

const OWNER = `0x${'aa'.repeat(32)}`;
const OTHER_OWNER = `0x${'bb'.repeat(32)}`;
const PEER = `0x${'cc'.repeat(32)}`;
const UPSTREAM = `0x${'dd'.repeat(32)}`;

const canonicalInput = (owner = OWNER): EntityInput => ({
  entityId: owner,
  signerId: '1',
  entityTxs: [],
});

const lifecycleProvider = (): Readonly<{
  provider: AccountAuthorityEntityStageProvider;
  begins: AccountAuthorityEntityStageBegin[];
  discardCount(): number;
}> => {
  const begins: AccountAuthorityEntityStageBegin[] = [];
  let discards = 0;
  return {
    begins,
    discardCount: () => discards,
    provider: {
      async beginEntityStage(begin) {
        begins.push(begin);
        return { discard: async () => { discards += 1; } };
      },
    },
  };
};

const options = (
  provider: AccountAuthorityEntityStageProvider,
  mode: AccountAuthorityEntityStageOptions['mode'] = 'pre-ts-observe',
  inputIndex = 0,
  ownerEntityId = OWNER,
): AccountAuthorityEntityStageOptions => ({
  mode,
  ownerEntityId,
  provider,
  occurrence: { kind: 'runtime-input', inputIndex },
  deferProposal: false,
});

const activeStage = (
  stage: AccountAuthorityEntityStage | undefined,
): AccountAuthorityEntityStage => {
  if (stage === undefined) throw new Error('TEST_ACCOUNT_AUTHORITY_CAPABILITY_MISSING');
  return stage;
};

describe('pre-TypeScript Account authority capability', () => {
  test('counts exact Account entry points after one lazy Begin, then discards and clears', async () => {
    const env = createEmptyEnv('account-authority-pre-ts-counts');
    const lifecycle = lifecycleProvider();
    const account = makeAccount(OWNER, PEER);
    let counts = { applyAccountInput: -1, proposeAccountFrame: -1 };

    await runAccountAuthorityEntityStage(env, options(lifecycle.provider), async () => {
      const stage = activeStage(env.accountAuthorityEntityStage);
      stage.bindCanonicalInput(canonicalInput());
      expect(lifecycle.begins).toHaveLength(0);
      const context = createAccountConsensusContext(env);
      await applyAccountInput(context, account, { kind: 'enqueue', txs: [] });
      await proposeAccountFrame(context, account, 100);
      counts = stage.typeScriptExecutionCounts();
    });

    expect(counts).toEqual({ applyAccountInput: 1, proposeAccountFrame: 1 });
    expect(lifecycle.begins[0]?.firstOperation).toEqual({
      kind: 'applyAccountInput',
      accountId: PEER,
    });
    expect(lifecycle.discardCount()).toBe(1);
    expect(env.accountAuthorityEntityStage).toBeUndefined();
  });

  test('a thrown Entity apply discards its savepoint and clears the capability', async () => {
    const env = createEmptyEnv('account-authority-pre-ts-throw');
    const lifecycle = lifecycleProvider();
    let counts = { applyAccountInput: -1, proposeAccountFrame: -1 };

    await expect(runAccountAuthorityEntityStage(env, options(lifecycle.provider), async () => {
      const stage = activeStage(env.accountAuthorityEntityStage);
      stage.bindCanonicalInput(canonicalInput());
      await stage.beforeTypeScriptAccountExecution('applyAccountInput', PEER);
      counts = stage.typeScriptExecutionCounts();
      throw new Error('TEST_ENTITY_APPLY_THROW');
    })).rejects.toThrow('TEST_ENTITY_APPLY_THROW');

    expect(counts).toEqual({ applyAccountInput: 1, proposeAccountFrame: 0 });
    expect(lifecycle.discardCount()).toBe(1);
    expect(env.accountAuthorityEntityStage).toBeUndefined();
  });

  test('cutover with no executor refuses the Account call before replica mutation', async () => {
    const env = createEmptyEnv('account-authority-cutover-gate');
    const lifecycle = lifecycleProvider();
    const account = makeAccount(OWNER, PEER);

    await expect(runAccountAuthorityEntityStage(
      env,
      options(lifecycle.provider, 'cutover'),
      async () => {
        activeStage(env.accountAuthorityEntityStage).bindCanonicalInput(canonicalInput());
        await applyAccountInput(createAccountConsensusContext(env), account, {
          kind: 'enqueue',
          txs: [{
            type: 'direct_payment',
            data: {
              tokenId: 1,
              amount: 1n,
              route: [PEER],
              fromEntityId: OWNER,
              toEntityId: PEER,
              description: 'must not reach TypeScript',
            },
          }],
        });
      },
    )).rejects.toThrow(`ACCOUNT_AUTHORITY_FRAME_NOT_OPEN:${OWNER}`);

    expect(account.mempool).toEqual([]);
    // Cutover stages are accepted or discarded with the Entity input, by the
    // runtime that decided; the stage itself never discards its own work.
    expect(lifecycle.discardCount()).toBe(0);
    expect(env.accountAuthorityEntityStage).toBeUndefined();
  });

  test('cutover visits the Account engine exactly once inbound and once outbound', async () => {
    const account = makeAccount(OWNER, PEER);
    let inboundBatches = 0;
    let outboundBatches = 0;
    let outboundAdmissions = 0;
    const provider: AccountAuthorityEntityStageProvider = {
      async beginEntityStage() {
        throw new Error('TEST_PER_OPERATION_STAGE_MUST_NOT_OPEN');
      },
      async executeAccountInboundBatch(batch) {
        inboundBatches += 1;
        expect(batch.requests).toHaveLength(0);
        return [];
      },
      async executeAccountOutboundBatch(batch) {
        outboundBatches += 1;
        outboundAdmissions = batch.admissions.length;
        expect(batch.proposals).toHaveLength(0);
        return { proposals: [], generatedAdmissions: [] };
      },
    };
    const stage = createAccountAuthorityEntityStage(options(provider, 'cutover'));
    stage.bindCanonicalInput(canonicalInput());

    await stage.beginEntityAccountFrame?.({
      ownerEntityId: OWNER,
      expectedAccountsRoot: `0x${'00'.repeat(32)}`,
      entityTxs: [],
      accounts: new Map([[PEER, account]]),
      accountForWrite: accountId => accountId === PEER ? account : undefined,
      entityTimestamp: 100,
      finalizedJHeight: 7,
    });
    const admitted = await stage.executeAccountInput({
      collectorFrameId: 'test-frame',
      account,
      input: {
        kind: 'enqueue',
        txs: [{
          type: 'direct_payment',
          data: {
            tokenId: 1,
            amount: 1n,
            route: [PEER],
            fromEntityId: OWNER,
            toEntityId: PEER,
            description: 'two-batch contract',
          },
        }],
      },
      entityTimestamp: 100,
      finalizedJHeight: 7,
    });
    expect(admitted?.ok).toBe(true);
    await stage.prepareEntityAccountOutbound?.({
      accounts: new Map([[PEER, account]]),
      proposalAccountIds: [],
      failedHtlcRoutes: [],
      timestamp: 100,
      jHeight: 7,
    });
    stage.finishEntityAccountFrame?.();

    expect({ inboundBatches, outboundBatches, outboundAdmissions }).toEqual({
      inboundBatches: 1,
      outboundBatches: 1,
      outboundAdmissions: 1,
    });
    expect(stage.authoritativeExecutionCount()).toBe(1);
    expect(stage.typeScriptExecutionCounts()).toEqual({
      applyAccountInput: 0,
      proposeAccountFrame: 0,
    });
    await stage.discard();
  });

  test('one outbound result carries a failed-forward admission and its dynamic proposal', async () => {
    const downstream = makeAccount(OWNER, PEER);
    const upstream = makeAccount(OWNER, UPSTREAM);
    const generatedInput = {
      kind: 'enqueue' as const,
      txs: [{
        type: 'htlc_resolve' as const,
        data: {
          lockId: `0x${'44'.repeat(32)}`,
          outcome: 'error' as const,
          reason: 'forward_failed:expired',
        },
      }],
    };
    const provider: AccountAuthorityEntityStageProvider = {
      async beginEntityStage() {
        throw new Error('TEST_PER_OPERATION_STAGE_MUST_NOT_OPEN');
      },
      async executeAccountInboundBatch() {
        return [];
      },
      async executeAccountOutboundBatch() {
        return {
          proposals: [
            {
              accountId: PEER,
              result: proposeAccountFrameIdle({ message: 'downstream rejected', events: [] }),
            },
            {
              accountId: UPSTREAM,
              result: proposeAccountFrameIdle({ message: 'upstream resolve rejected', events: [] }),
            },
          ],
          generatedAdmissions: [{
            accountId: UPSTREAM,
            input: generatedInput,
            result: accountInputApplied({ events: [], admittedAccountTxCount: 1 }),
          }],
        };
      },
    };
    const stage = createAccountAuthorityEntityStage(options(provider, 'cutover'));
    stage.bindCanonicalInput(canonicalInput());
    const accounts = new Map([[PEER, downstream], [UPSTREAM, upstream]]);
    await stage.beginEntityAccountFrame?.({
      ownerEntityId: OWNER,
      expectedAccountsRoot: `0x${'00'.repeat(32)}`,
      entityTxs: [],
      accounts,
      accountForWrite: accountId => accounts.get(accountId),
      entityTimestamp: 100,
      finalizedJHeight: 7,
    });
    await stage.prepareEntityAccountOutbound?.({
      accounts,
      proposalAccountIds: [PEER],
      failedHtlcRoutes: [],
      timestamp: 100,
      jHeight: 7,
    });

    expect(stage.hasPreparedAccountProposal?.(PEER)).toBe(true);
    expect(stage.hasPreparedAccountProposal?.(UPSTREAM)).toBe(true);
    expect((await stage.executeAccountProposal({
      collectorFrameId: OWNER,
      account: downstream,
      timestamp: 100,
      jHeight: 7,
      entityTimestamp: 100,
      finalizedJHeight: 7,
      selectionIsWholeMempool: true,
    }))?.ok).toBe(true);
    expect((await stage.executeAccountInput({
      collectorFrameId: OWNER,
      account: upstream,
      input: generatedInput,
      entityTimestamp: 100,
      finalizedJHeight: 7,
    }))?.admittedAccountTxCount).toBe(1);
    expect((await stage.executeAccountProposal({
      collectorFrameId: OWNER,
      account: upstream,
      timestamp: 100,
      jHeight: 7,
      entityTimestamp: 100,
      finalizedJHeight: 7,
      selectionIsWholeMempool: true,
    }))?.ok).toBe(true);
    stage.finishEntityAccountFrame?.();
  });

  test('accepted canonical ingress binds before Account work without eager Begin', async () => {
    const fixture = createEntityProposalFixture('account-authority-canonical-ingress', 1n);
    const validator = fixture.createValidator('1');
    const lifecycle = lifecycleProvider();
    const rawInput: EntityInput = {
      entityId: fixture.entityId,
      signerId: validator.signerId,
      entityTxs: [],
    };

    await runAccountAuthorityEntityStage(
      validator.env,
      options(lifecycle.provider, 'pre-ts-observe', 2, fixture.entityId),
      async () => {
        await applyEntityInput(validator.env, validator.replica, rawInput);
        expect(lifecycle.begins).toHaveLength(0);
        rawInput.entityTxs?.push({
          type: 'chat',
          data: { from: validator.signerId, message: 'late mutation' },
        });
        await activeStage(validator.env.accountAuthorityEntityStage)
          .beforeTypeScriptAccountExecution('proposeAccountFrame', PEER);
      },
    );

    expect(lifecycle.begins[0]?.canonicalEntityInput.entityTxs).toEqual([]);
    expect(lifecycle.begins[0]?.occurrence).toEqual({ kind: 'runtime-input', inputIndex: 2 });
    expect(lifecycle.discardCount()).toBe(1);
    expect(validator.env.accountAuthorityEntityStage).toBeUndefined();
  });

  test('identical rejected inputs at adjacent Runtime indexes open distinct identities', async () => {
    const env = createEmptyEnv('account-authority-occurrence');
    const lifecycle = lifecycleProvider();
    const rejectAt = async (inputIndex: number): Promise<void> => {
      await expect(runAccountAuthorityEntityStage(
        env,
        options(lifecycle.provider, 'pre-ts-observe', inputIndex),
        async () => {
          const stage = activeStage(env.accountAuthorityEntityStage);
          stage.bindCanonicalInput(canonicalInput());
          await stage.beforeTypeScriptAccountExecution('applyAccountInput', PEER);
          throw new Error('TEST_IDENTICAL_ENTITY_INPUT_REJECTED');
        },
      )).rejects.toThrow('TEST_IDENTICAL_ENTITY_INPUT_REJECTED');
    };

    await rejectAt(9);
    await rejectAt(10);
    expect(lifecycle.begins.map(begin => begin.occurrence)).toEqual([
      { kind: 'runtime-input', inputIndex: 9 },
      { kind: 'runtime-input', inputIndex: 10 },
    ]);
    expect(lifecycle.discardCount()).toBe(2);
    expect(env.accountAuthorityEntityStage).toBeUndefined();
  });

  test('absent mode is inert; missing, mixed, and malformed modes fail loudly', async () => {
    const env = createEmptyEnv('account-authority-configuration');
    const lifecycle = lifecycleProvider();
    const transition = {
      ownerEntityId: OWNER,
      occurrence: { kind: 'runtime-input' as const, inputIndex: 0 },
      deferProposal: false,
    };
    expect(resolveAccountAuthorityEntityStageOptions({}, transition, false)).toBeNull();
    await expect(runAccountAuthorityEntityStage(env, null, async () => 'canonical-ts'))
      .resolves.toBe('canonical-ts');
    expect(() => resolveAccountAuthorityEntityStageOptions(
      { accountAuthorityExecutionMode: 'cutover' }, transition, false,
    )).toThrow('ACCOUNT_AUTHORITY_ENTITY_STAGE_PROVIDER_REQUIRED:cutover');
    expect(() => resolveAccountAuthorityEntityStageOptions(
      { accountAuthorityEntityStageProvider: lifecycle.provider }, transition, false,
    )).toThrow('ACCOUNT_AUTHORITY_ENTITY_STAGE_MODE_REQUIRED');
    expect(() => resolveAccountAuthorityEntityStageOptions({
      accountAuthorityExecutionMode: 'pre-ts-observe',
      accountAuthorityEntityStageProvider: lifecycle.provider,
    }, transition, true)).toThrow(
      'ACCOUNT_AUTHORITY_MODE_CONFLICT:pre-ts-observe:post-ts-migration',
    );
    expect(() => createAccountAuthorityEntityStage({
      ...options(lifecycle.provider),
      occurrence: { kind: 'runtime-input', inputIndex: -1 },
    })).toThrow('ACCOUNT_AUTHORITY_ENTITY_OCCURRENCE_INVALID:runtime-input:-1');
    const stage = createAccountAuthorityEntityStage(options(lifecycle.provider));
    expect(() => stage.bindCanonicalInput(canonicalInput(OTHER_OWNER))).toThrow(
      `ACCOUNT_AUTHORITY_CANONICAL_INPUT_OWNER_MISMATCH:${OWNER}:${OTHER_OWNER}`,
    );
  });

  test('cleanup failure cannot leak the active capability', async () => {
    const env = createEmptyEnv('account-authority-cleanup-failure');
    const provider: AccountAuthorityEntityStageProvider = {
      async beginEntityStage() {
        return { discard: async () => { throw new Error('TEST_SAVEPOINT_DISCARD_FAILED'); } };
      },
    };
    await expect(runAccountAuthorityEntityStage(env, options(provider), async () => {
      const stage = activeStage(env.accountAuthorityEntityStage);
      stage.bindCanonicalInput(canonicalInput());
      await stage.beforeTypeScriptAccountExecution('applyAccountInput', PEER);
    })).rejects.toThrow('TEST_SAVEPOINT_DISCARD_FAILED');
    expect(env.accountAuthorityEntityStage).toBeUndefined();
  });
});
