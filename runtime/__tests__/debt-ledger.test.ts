import { describe, expect, test } from 'bun:test';

import { getJEventJurisdictionRef } from '../jurisdiction/event-observation';
import { decode, encode } from '../storage/snapshot-coder';
import { cloneEntityState } from '../state-helpers';
import {
  applyJEventRange,
  buildJEventRangeData,
  type LegacyJEventInput,
} from './helpers/j-history';
import {
  applyDebtCreated,
  applyDebtEnforced,
  applyDebtForgiven,
} from '../entity/tx/j-events-debt';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account/crypto';
import { createEmptyEnv, generateLazyEntityId } from '../runtime';
import { applyJEvent } from '../entity/tx/j-events';
import { computeCanonicalEntityConsensusStateHash } from '../entity/consensus/state-root';
import { applyEntityTx } from '../entity/tx/apply';
import { hydrateEntityStateFromStorage, projectEntityCoreDoc } from '../storage/projections';
import type { StorageEntityCoreDoc } from '../storage/types';
import type {
  ConsensusConfig,
  EntityState,
  JReplica,
  JurisdictionConfig,
  JurisdictionEvent,
} from '../types';

const SEED = 'debt-ledger-seed';
const ALICE_SIGNER = deriveSignerAddressSync(SEED, '1').toLowerCase();
const BOB_SIGNER = deriveSignerAddressSync(SEED, '2').toLowerCase();
const ALICE = generateLazyEntityId([ALICE_SIGNER], 1n).toLowerCase();
const BOB = generateLazyEntityId([BOB_SIGNER], 1n).toLowerCase();
const CAROL = `0x${'55'.repeat(32)}`;
const JURISDICTION: JurisdictionConfig = {
  name: 'DebtLedgerObserved',
  address: 'rpc://debt-ledger-observed',
  chainId: 31_337,
  depositoryAddress: '0x3333333333333333333333333333333333333333',
  entityProviderAddress: '0x4444444444444444444444444444444444444444',
};

const makeConfig = (signerId: string): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: [signerId],
  shares: { [signerId]: 1n },
  jurisdiction: JURISDICTION,
});

const makeState = (entityId: string, signerId: string): EntityState => ({
  entityId,
  height: 0,
  timestamp: 1_000,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: makeConfig(signerId),
  reserves: new Map(),
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  entityEncPubKey: `${'0x'}${'11'.repeat(32)}`,
  entityEncPrivKey: `${'0x'}${'22'.repeat(32)}`,
  profile: {
    name: entityId === ALICE ? 'Alice' : 'Bob',
    isHub: false,
    avatar: '',
    bio: '',
    website: '',
  },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  lockBook: new Map(),
  swapTradingPairs: [],
});

const installJurisdiction = (env: ReturnType<typeof createEmptyEnv>): void => {
  env.activeJurisdiction = JURISDICTION.name;
  env.jReplicas.set(JURISDICTION.name, {
    name: JURISDICTION.name,
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    rpcs: [JURISDICTION.address!],
    chainId: JURISDICTION.chainId,
    watcherConfirmationDepth: 0,
    depositoryAddress: JURISDICTION.depositoryAddress,
    entityProviderAddress: JURISDICTION.entityProviderAddress,
    contracts: {
      depository: JURISDICTION.depositoryAddress,
      entityProvider: JURISDICTION.entityProviderAddress,
    },
    position: { x: 0, y: 0, z: 0 },
  } satisfies JReplica);
};

const makeJEventInput = (
  env: ReturnType<typeof createEmptyEnv>,
  entityId: string,
  signerId: string,
  event: JurisdictionEvent,
  blockNumber: number,
  transactionHash: string,
): LegacyJEventInput => {
  const blockHash = `0x${String(blockNumber).padStart(64, '0')}`;
  const jurisdictionRef = getJEventJurisdictionRef(JURISDICTION);
  return {
    from: signerId,
    jurisdictionRef,
    event,
    observedAt: 1_000 + blockNumber,
    blockNumber,
    blockHash,
    transactionHash,
  };
};

const findOnlyDebt = (state: EntityState, direction: 'out' | 'in', tokenId = 1) => {
  const bucket = (direction === 'out' ? state.outDebtsByToken : state.inDebtsByToken)?.get(tokenId);
  expect(bucket?.size).toBe(1);
  return Array.from(bucket!.values())[0]!;
};

const debtCount = (state: EntityState, direction: 'out' | 'in'): number => {
  const ledger = direction === 'out' ? state.outDebtsByToken : state.inDebtsByToken;
  return Array.from(ledger?.values() ?? []).reduce((count, bucket) => count + bucket.size, 0);
};

describe('debt ledger', () => {
  test('records debt ledger divergence without direct console warning and fails closed', () => {
    const state = makeState(ALICE, ALICE_SIGNER);
    const event: Extract<JurisdictionEvent, { type: 'DebtEnforced' }> = {
      type: 'DebtEnforced',
      blockNumber: 15,
      transactionHash: `0x${'dd'.repeat(32)}`,
      data: {
        debtor: ALICE,
        creditor: BOB,
        tokenId: 1,
        amountPaid: '10',
        remainingAmount: '140',
        newDebtIndex: 4,
      },
    };
    expect(() => applyDebtEnforced(state, event)).toThrow('DEBT_LEDGER_DIVERGENCE:DebtEnforced');
    expect(state.messages).toEqual([]);
  });

  test('keeps only active mirrored debt aggregates, survives restore, and rejects stale J replay', async () => {
    const env = createEmptyEnv(SEED);
    registerSignerKey(env, ALICE_SIGNER, deriveSignerKeySync(SEED, '1'));
    registerSignerKey(env, BOB_SIGNER, deriveSignerKeySync(SEED, '2'));
    installJurisdiction(env);
    env.quietRuntimeLogs = true;

    let aliceState = makeState(ALICE, ALICE_SIGNER);
    let bobState = makeState(BOB, BOB_SIGNER);

    const created: JurisdictionEvent = {
      type: 'DebtCreated',
      blockNumber: 12,
      transactionHash: `0x${'aa'.repeat(32)}`,
      data: {
        debtor: ALICE,
        creditor: BOB,
        tokenId: 1,
        amount: '150',
        debtIndex: 3,
      },
    };

    const createdInput = makeJEventInput(env, ALICE, ALICE_SIGNER, created, 12, String(created.transactionHash));
    const createdRange = buildJEventRangeData(aliceState, createdInput, env);
    aliceState = (await applyJEvent(aliceState, createdRange, env)).newState;
    bobState = (await applyJEventRange(bobState, makeJEventInput(env, BOB, BOB_SIGNER, created, 12, String(created.transactionHash)), env)).newState;

    const aliceOpen = findOnlyDebt(aliceState, 'out');
    const bobIncoming = findOnlyDebt(bobState, 'in');

    expect(aliceOpen.direction).toBe('out');
    expect(aliceOpen.counterparty).toBe(BOB);
    expect(aliceOpen.createdAmount).toBe(150n);
    expect(aliceOpen.remainingAmount).toBe(150n);
    expect(aliceOpen.status).toBe('open');
    expect(bobIncoming.direction).toBe('in');
    expect(bobIncoming.counterparty).toBe(ALICE);
    expect(bobIncoming.debtId).toBe(aliceOpen.debtId);

    const enforced: JurisdictionEvent = {
      type: 'DebtEnforced',
      blockNumber: 13,
      transactionHash: `0x${'bb'.repeat(32)}`,
      data: {
        debtor: ALICE,
        creditor: BOB,
        tokenId: 1,
        amountPaid: '100',
        remainingAmount: '50',
        newDebtIndex: 3,
      },
    };

    aliceState = (await applyJEventRange(aliceState, makeJEventInput(env, ALICE, ALICE_SIGNER, enforced, 13, String(enforced.transactionHash)), env)).newState;
    bobState = (await applyJEventRange(bobState, makeJEventInput(env, BOB, BOB_SIGNER, enforced, 13, String(enforced.transactionHash)), env)).newState;

    const alicePartial = findOnlyDebt(aliceState, 'out');
    const bobPartial = findOnlyDebt(bobState, 'in');
    expect(alicePartial.paidAmount).toBe(100n);
    expect(alicePartial.remainingAmount).toBe(50n);
    expect(alicePartial.currentDebtIndex).toBe(3);
    expect(alicePartial.status).toBe('open');
    expect(Object.hasOwn(alicePartial, 'updates')).toBe(false);
    expect(bobPartial.paidAmount).toBe(100n);
    expect(bobPartial.remainingAmount).toBe(50n);

    const cloned = cloneEntityState(aliceState);
    const clonedDebt = findOnlyDebt(cloned, 'out');
    expect(Object.hasOwn(clonedDebt, 'updates')).toBe(false);
    expect(clonedDebt.remainingAmount).toBe(50n);

    const restored = decode<EntityState>(encode(aliceState));
    const restoredDebt = findOnlyDebt(restored, 'out');
    expect(restoredDebt.status).toBe('open');
    expect(restoredDebt.paidAmount).toBe(100n);
    expect(restoredDebt.remainingAmount).toBe(50n);
    expect(Object.hasOwn(restoredDebt, 'updates')).toBe(false);

    const forgiven: JurisdictionEvent = {
      type: 'DebtForgiven',
      blockNumber: 14,
      transactionHash: `0x${'cc'.repeat(32)}`,
      data: {
        debtor: ALICE,
        creditor: BOB,
        tokenId: 1,
        amountForgiven: '50',
        debtIndex: 3,
      },
    };

    const forgivenInput = makeJEventInput(env, ALICE, ALICE_SIGNER, forgiven, 14, String(forgiven.transactionHash));
    const forgivenRange = buildJEventRangeData(aliceState, forgivenInput, env);
    aliceState = (await applyJEvent(aliceState, forgivenRange, env)).newState;
    bobState = (await applyJEventRange(bobState, makeJEventInput(env, BOB, BOB_SIGNER, forgiven, 14, String(forgiven.transactionHash)), env)).newState;

    expect(aliceState.outDebtsByToken).toBeUndefined();
    expect(bobState.inDebtsByToken).toBeUndefined();

    const replay = await applyJEvent(aliceState, createdRange, env);
    expect(replay.newState).toBe(aliceState);
    expect(replay.outputs).toEqual([]);
    expect(replay.mempoolOps).toEqual([]);
    expect(aliceState.outDebtsByToken).toBeUndefined();

    const terminalReplay = await applyJEvent(aliceState, forgivenRange, env);
    expect(terminalReplay.newState).toBe(aliceState);
    expect(aliceState.outDebtsByToken).toBeUndefined();
  });

  test('keeps one active aggregate through one million updates and resumes after persistence', () => {
    let state = makeState(ALICE, ALICE_SIGNER);
    applyDebtCreated(state, {
      type: 'DebtCreated',
      blockNumber: 1,
      transactionHash: `0x${'01'.repeat(32)}`,
      data: { debtor: ALICE, creditor: BOB, tokenId: 1, amount: '1000001', debtIndex: 0 },
    });

    for (let index = 0; index < 3; index += 1) {
      applyDebtEnforced(state, {
        type: 'DebtEnforced',
        blockNumber: index + 2,
        transactionHash: `0x${'02'.repeat(32)}`,
        data: {
          debtor: ALICE,
          creditor: BOB,
          tokenId: 1,
          amountPaid: '1',
          remainingAmount: String(1_000_000 - index),
          newDebtIndex: 0,
        },
      });
    }
    const afterThree = findOnlyDebt(state, 'out');
    expect(Object.hasOwn(afterThree, 'updates')).toBe(false);
    const boundedBytes = encode(state).byteLength;

    for (let index = 3; index < 500_000; index += 1) {
      applyDebtEnforced(state, {
        type: 'DebtEnforced',
        blockNumber: index + 2,
        transactionHash: `0x${'02'.repeat(32)}`,
        data: {
          debtor: ALICE,
          creditor: BOB,
          tokenId: 1,
          amountPaid: '1',
          remainingAmount: String(1_000_000 - index),
          newDebtIndex: 0,
        },
      });
    }
    const beforeRestoreHash = computeCanonicalEntityConsensusStateHash(state);
    const persistedCore = decode<StorageEntityCoreDoc>(encode(projectEntityCoreDoc(state)));
    state = hydrateEntityStateFromStorage({ core: persistedCore, accounts: new Map(), books: new Map() });
    expect(computeCanonicalEntityConsensusStateHash(state)).toBe(beforeRestoreHash);

    for (let index = 500_000; index < 1_000_000; index += 1) {
      applyDebtEnforced(state, {
        type: 'DebtEnforced',
        blockNumber: index + 2,
        transactionHash: `0x${'02'.repeat(32)}`,
        data: {
          debtor: ALICE,
          creditor: BOB,
          tokenId: 1,
          amountPaid: '1',
          remainingAmount: String(1_000_000 - index),
          newDebtIndex: 0,
        },
      });
    }

    const active = findOnlyDebt(state, 'out');
    expect(active.paidAmount).toBe(1_000_000n);
    expect(active.remainingAmount).toBe(1n);
    expect(encode(state).byteLength).toBeLessThanOrEqual(boundedBytes + 128);

    applyDebtEnforced(state, {
      type: 'DebtEnforced',
      blockNumber: 1_000_002,
      transactionHash: `0x${'03'.repeat(32)}`,
      data: {
        debtor: ALICE,
        creditor: BOB,
        tokenId: 1,
        amountPaid: '1',
        remainingAmount: '0',
        newDebtIndex: 1,
      },
    });
    expect(state.outDebtsByToken).toBeUndefined();
  });

  test('preserves FIFO across counterparties and deterministically retires terminal records', () => {
    const applySequence = (state: EntityState): EntityState => {
      applyDebtCreated(state, {
        type: 'DebtCreated', blockNumber: 1, transactionHash: `0x${'11'.repeat(32)}`,
        data: { debtor: ALICE, creditor: BOB, tokenId: 1, amount: '5', debtIndex: 0 },
      });
      applyDebtCreated(state, {
        type: 'DebtCreated', blockNumber: 2, transactionHash: `0x${'12'.repeat(32)}`,
        data: { debtor: ALICE, creditor: CAROL, tokenId: 1, amount: '7', debtIndex: 1 },
      });
      applyDebtEnforced(state, {
        type: 'DebtEnforced', blockNumber: 3, transactionHash: `0x${'13'.repeat(32)}`,
        data: { debtor: ALICE, creditor: BOB, tokenId: 1, amountPaid: '5', remainingAmount: '0', newDebtIndex: 1 },
      });
      expect(debtCount(state, 'out')).toBe(1);
      expect(findOnlyDebt(state, 'out').creditor).toBe(CAROL);
      applyDebtEnforced(state, {
        type: 'DebtEnforced', blockNumber: 4, transactionHash: `0x${'14'.repeat(32)}`,
        data: { debtor: ALICE, creditor: CAROL, tokenId: 1, amountPaid: '3', remainingAmount: '4', newDebtIndex: 1 },
      });
      return state;
    };

    const left = applySequence(makeState(ALICE, ALICE_SIGNER));
    const right = applySequence(makeState(ALICE, ALICE_SIGNER));
    expect(computeCanonicalEntityConsensusStateHash(left)).toBe(computeCanonicalEntityConsensusStateHash(right));
    expect(findOnlyDebt(left, 'out').remainingAmount).toBe(4n);

    applyDebtForgiven(left, {
      type: 'DebtForgiven', blockNumber: 5, transactionHash: `0x${'15'.repeat(32)}`,
      data: { debtor: ALICE, creditor: CAROL, tokenId: 1, amountForgiven: '4', debtIndex: 1 },
    });
    expect(left.outDebtsByToken).toBeUndefined();
  });

  test('writes every debt event to the bounded Runtime activity log, not EntityState history', async () => {
    const env = createEmptyEnv(SEED);
    registerSignerKey(env, ALICE_SIGNER, deriveSignerKeySync(SEED, '1'));
    installJurisdiction(env);
    const state = makeState(ALICE, ALICE_SIGNER);
    const created: JurisdictionEvent = {
      type: 'DebtCreated', blockNumber: 20, transactionHash: `0x${'21'.repeat(32)}`,
      data: { debtor: ALICE, creditor: BOB, tokenId: 1, amount: '9', debtIndex: 0 },
    };
    const enforced: JurisdictionEvent = {
      type: 'DebtEnforced', blockNumber: 20, transactionHash: `0x${'21'.repeat(32)}`,
      data: { debtor: ALICE, creditor: BOB, tokenId: 1, amountPaid: '4', remainingAmount: '5', newDebtIndex: 0 },
    };
    const data = buildJEventRangeData(state, {
      ...makeJEventInput(env, ALICE, ALICE_SIGNER, created, 20, String(created.transactionHash)),
      events: [created, enforced],
    }, env);

    const result = await applyEntityTx(env, state, { type: 'j_event', data });
    expect(findOnlyDebt(result.newState, 'out').remainingAmount).toBe(5n);
    expect(Object.hasOwn(findOnlyDebt(result.newState, 'out'), 'updates')).toBe(false);
    expect(env.frameLogs.filter((entry) => entry.message === 'JEventReceived').map((entry) => entry.data?.['eventType']))
      .toEqual(['DebtCreated', 'DebtEnforced']);
  });
});
