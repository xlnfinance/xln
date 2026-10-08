import { prepareLocallyAuthoredEntityTxs, advanceEntityCommandNonce } from '../../../../entity/command';
import { setFailFastErrors } from '../../../../support/logger';
import {
  createEmptyEnv,
  closeRuntimeDb,
  closeInfraDb,
  loadEnvFromDB,
  readPersistedFrameJournal,
} from '../../../../runtime';
import { deriveSignerAddressSync } from '../../../../account/crypto';
import { generateLazyEntityId } from '../../../../entity/factory';
import { resolveScenarioBoardSigner } from '../../../../scenarios/harness/boot';
import { htlcLazy } from '../../../../scenarios/payments/htlc-lazy';
import {
  commitRuntimeInput,
  converge,
  findReplica,
  getOffdelta,
  enableStrictScenario,
} from '../../../../scenarios/harness/helpers';
import { quoteHtlcPaymentRoute } from '../../../../pathfinding/htlc-quote';
import { expect, test } from 'bun:test';
import {
  hashRawHtlcPaymentTx,
  assertOriginatedHtlcPayments,
  materializeOriginatedHtlcPayments,
} from '../../../../entity/paybook/payment-admission';
import type { Profile } from '../../../../entity/profile';
import type { EntityTx } from '../../../../types/entity-tx';
import { entity, makeJurisdiction, makeState } from '../../../helpers/cross-j';

// The range certificate is checked by Entity consensus before this boundary.
// Exercise actual onion preparation and validator economics, with a catch-up
// greater than the complete instant-payment enforcement window.
test('htlcPayment uses preceding certified catch-up height for preparation and validation', async () => {
  const source = entity('11');
  const target = entity('22');
  const jurisdiction = makeJurisdiction('catchup', 31337, '33', '44');
  const state = makeState(source, entity('55'), jurisdiction, target);
  const peer = makeState(target, entity('66'), jurisdiction, source);
  state.lastFinalizedJHeight = 100;
  const profiles: Profile[] = [state, peer].map((owner, index) => ({
    entityId: owner.entityId,
    entityEncryptionPublicKey: owner.entityEncryptionPublicKey,
    name: '',
    avatar: '',
    bio: '',
    website: '',
    lastUpdated: state.timestamp,
    runtimeId: '',
    runtimeEncPubKey: '',
    publicAccounts: [],
    wsUrl: null,
    relays: [],
    metadata: {},
    accounts: [
      {
        counterpartyId: index === 0 ? target : source,
        domain: { chainId: jurisdiction.chainId!, depositoryAddress: jurisdiction.depositoryAddress! },
        tokenCapacities: { 1: { inCapacity: 1000n, outCapacity: 1000n } },
      },
    ],
  }));
  const payment: EntityTx = {
    type: 'htlcPayment',
    data: {
      targetEntityId: target,
      tokenId: 1,
      amount: 10n,
      maxSenderDebit: 10n,
      route: [source, target],
      deliveryMode: 'instant',
    },
  };
  const range: EntityTx = {
    type: 'j_event',
    data: {
      from: entity('55'),
      jurisdictionRef: 'catchup',
      baseHeight: 100,
      scannedThroughHeight: 200,
      tipBlockHash: entity('77'),
      eventHistoryRoot: entity('88'),
      rangeHash: entity('99'),
      blocks: [],
      signature: '',
      observedAt: 200,
    },
  };
  const prepare = async (proposalTxs: EntityTx[]) => {
    const input = { state, proposalTxs, profiles, height: 1, resolveRoute: async () => [source, target] };
    const originated = await materializeOriginatedHtlcPayments(input);
    expect(() => assertOriginatedHtlcPayments({ ...input, originated })).not.toThrow();
    return { input, originated };
  };
  const before = await prepare([payment]);
  const missingIntermediary = entity('77');
  const unroutablePayment: EntityTx = {
    ...payment,
    data: { ...payment.data, route: [source, missingIntermediary, target] },
  };
  await expect(
    materializeOriginatedHtlcPayments({
      state,
      proposalTxs: [unroutablePayment],
      profiles,
      height: 1,
      resolveRoute: async () => [source, target],
    }),
  ).rejects.toMatchObject({
    disposition: 'reject',
    txType: 'htlcPayment',
    frameTx: unroutablePayment,
    rejection: `HTLC_PAYMENT_PROFILE_MATCH_COUNT:${missingIntermediary}:0`,
  });
  const caughtUp = await prepare([range, payment]);
  expect(caughtUp.originated[0]!.revealBeforeHeight).toBe(before.originated[0]!.revealBeforeHeight + 100);
  expect(caughtUp.originated[0]!.revealBeforeHeight).toBeGreaterThan(200);
  expect(() => assertOriginatedHtlcPayments({ ...caughtUp.input, originated: before.originated })).toThrow(
    'REVEALBEFOREHEIGHT_MISMATCH',
  );
  const later = await prepare([payment, range]);
  expect(later.originated[0]!.revealBeforeHeight).toBe(before.originated[0]!.revealBeforeHeight);
});

test.each(['hashlock', 'no-route'] as const)('rejected %s signed HTLC command and future nonce leave runtime live for valid-next payment and exact WAL recovery', async rejection => {
  const previousJAdapter = process.env.JADAPTER_MODE;
  process.env.JADAPTER_MODE = 'browservm';
  const rejectPolicy = process.env.XLN_REJECT_FAIL_FAST;
  process.env.XLN_REJECT_FAIL_FAST = '0';
  const prefix = `origin-mixed-wal-${process.pid}-${Date.now()}`;
  let seed = '';
  for (let i = 0; i < 100; i++) {
    const candidate = `${prefix}-${i}`;
    const ids = ['2', '3', '4'].map(label =>
      generateLazyEntityId([deriveSignerAddressSync(candidate, label)], 1n).toLowerCase(),
    );
    if (ids[0]! > ids[1]! && ids[1]! < ids[2]!) {
      seed = candidate;
      break;
    }
  }
  if (!seed) throw new Error('SCENARIO_LEXICAL_ROLE_SEED_UNAVAILABLE');
  const env = createEmptyEnv(seed);
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  env.runtimeId = runtimeId;
  env.dbNamespace = runtimeId;
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  env.state.timestamp = 1_000;
  env.runtimeConfig = {
    ...env.runtimeConfig,
    storage: { ...env.runtimeConfig?.storage, snapshotPeriodFrames: 10_000, materializePeriodFrames: 10_000 },
  };
  let restored: typeof env | null = null;
  const restoreStrict = enableStrictScenario(env, 'MIXED ORIGIN WAL');
  try {
    await htlcLazy(env);
    env.scenarioMode = true;
    const onlineObserver = env.infrastructure!.observeOnlineEntityIds;
    restoreStrict();
    env.infrastructure!.observeOnlineEntityIds = onlineObserver;
    setFailFastErrors(false);
    const signerId = resolveScenarioBoardSigner(env, '2');
    const source = generateLazyEntityId([signerId], 1n, env).toLowerCase();
    const hub = generateLazyEntityId([resolveScenarioBoardSigner(env, '3')], 1n, env).toLowerCase();
    const target = generateLazyEntityId([resolveScenarioBoardSigner(env, '4')], 1n, env).toLowerCase();
    const before = getOffdelta(env, source, hub, 1);
    const good: Extract<EntityTx, { type: 'htlcPayment' }> = {
      type: 'htlcPayment',
      data: {
        targetEntityId: target,
        tokenId: 1,
        amount: 1000n,
        maxSenderDebit: 1100n,
        route: [source, hub, target],
        deliveryMode: 'instant',
        description: 'mixed-wal-good',
      },
    };
    const bad: typeof good = {
      ...good,
      data: rejection === 'hashlock'
        ? { ...good.data, description: 'mixed-wal-bad', hashlock: `0x${'ff'.repeat(32)}` }
        : { ...good.data, description: 'mixed-wal-no-route', route: [], amount: 10n ** 30n, maxSenderDebit: 10n ** 30n },
    };
    const profiles = [source, hub, target].map(id => {
      const profile = env.gossip.getProfile(id);
      if (!profile) throw new Error(`PROFILE_MISSING:${id}`);
      return profile;
    });
    const quote = quoteHtlcPaymentRoute(profiles, good.data.route, 1, good.data.amount);
    const targetBefore = getOffdelta(env, hub, target, 1);
    const startHeight = env.state.height;
    const state = findReplica(env, source)[1].state;
    const badCommand = prepareLocallyAuthoredEntityTxs(env, state, signerId, [bad])[0]!;
    if (badCommand.type !== 'entityCommand') throw new Error('SIGNED_BAD_COMMAND_REQUIRED');
    const goodCommand = prepareLocallyAuthoredEntityTxs(
      env,
      advanceEntityCommandNonce(state, badCommand.data),
      signerId,
      [good],
    )[0]!;
    await commitRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{ entityId: source, signerId, entityTxs: [badCommand, goodCommand] }],
    });
    await converge(env, 80);
    expect(getOffdelta(env, source, hub, 1)).toBe(before);
    expect(findReplica(env, source)[1].mempool).toHaveLength(0);
    const replacement = prepareLocallyAuthoredEntityTxs(env, findReplica(env, source)[1].state, signerId, [good])[0]!;
    if (replacement.type !== 'entityCommand') throw new Error('SIGNED_REPLACEMENT_REQUIRED');
    expect(replacement.data.nonce).toBe(badCommand.data.nonce);
    await commitRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{ entityId: source, signerId, entityTxs: [replacement] }],
    });
    await converge(env, 80);
    const after = getOffdelta(env, source, hub, 1);
    expect(after > before ? after - before : before - after).toBe(quote.senderLockAmount);
    const targetAfter = getOffdelta(env, hub, target, 1);
    expect(targetAfter > targetBefore ? targetAfter - targetBefore : targetBefore - targetAfter).toBe(good.data.amount);
    expect(findReplica(env, source)[1].state.paybook.entries.size).toBe(0);
    const frames = [];
    for (let height = startHeight + 1; height <= env.state.height; height++) {
      const frame = await readPersistedFrameJournal(env, height);
      if (!frame) throw new Error(`MISSING_REAL_WAL:${height}`);
      frames.push(frame);
    }
    const rejectedFrame = frames[0]!;
    expect(rejectedFrame.runtimeInput.entityInputs.flatMap(input => input.entityTxs ?? []))
      .toEqual([badCommand, goodCommand]);
    const rejectedContext = [...rejectedFrame.entityContexts.values()]
      .flatMap(context => context.htlc?.originated ?? []);
    expect(rejectedContext.map(entry => entry.txHash)).toEqual([hashRawHtlcPaymentTx(good)]);
    expect(rejectedContext.some(entry => entry.txHash === hashRawHtlcPaymentTx(bad))).toBe(false);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.some(frame => frame.height > rejectedFrame.height &&
      frame.runtimeInput.entityInputs.some(input => input.entityTxs?.some(tx =>
        tx.type === 'entityCommand' && tx.data.signature === replacement.data.signature)))).toBe(true);
    const finalFrame = frames.at(-1)!;
    expect(finalFrame.materializedState).toBe(false);
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    restored = await loadEnvFromDB(runtimeId, seed);
    if (!restored) throw new Error('MIXED_ORIGIN_RESTORE_MISSING');
    expect(restored.state.height).toBe(finalFrame.height);
    expect(getOffdelta(restored, source, hub, 1)).toBe(after);
    expect(findReplica(restored, source)[1].state.paybook.entries.size).toBe(0);
  } finally {
    if (previousJAdapter === undefined) delete process.env.JADAPTER_MODE;
    else process.env.JADAPTER_MODE = previousJAdapter;
    if (rejectPolicy === undefined) delete process.env.XLN_REJECT_FAIL_FAST;
    else process.env.XLN_REJECT_FAIL_FAST = rejectPolicy;
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    if (restored) {
      await closeRuntimeDb(restored);
      await closeInfraDb(restored);
    }
  }
}, 60_000);
