import { describe, expect, test } from 'bun:test';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account/crypto';
import { canonicalJurisdictionEventsHash, getJEventJurisdictionRef } from '../jurisdiction/event-observation';
import { createEntityFrameHash } from '../entity/consensus/frame';
import { applyJEventRange, type LegacyJEventInput } from './helpers/j-history';
import { buildJEventsRuntimeInput } from '../jadapter/watcher';
import {
  applyRuntimeInput,
  createEmptyEnv,
  generateLazyEntityId,
} from '../runtime';
import { applySignerEntityExternalWalletSnapshot } from '../entity/signer-wallet';
import { cloneEntityState } from '../state-helpers';
import { hydrateEntityStateFromStorage, projectEntityCoreDoc } from '../storage/projections';
import type { ConsensusConfig, EntityReplica, EntityState, JurisdictionEvent } from '../types';

const TOKEN = '0x2222222222222222222222222222222222222222';
const SPENDER = '0x3333333333333333333333333333333333333333';
const NATIVE = '0x0000000000000000000000000000000000000000';
type ExternalWalletSnapshotEvent = Extract<JurisdictionEvent, { type: 'ExternalWalletSnapshot' }>;

const makeConfig = (signerId: string): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: [signerId],
  shares: { [signerId]: 1n },
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
    name: 'External wallet test',
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
  pendingSwapFillRatios: new Map(),
});

const signJEventInput = (
  env: ReturnType<typeof createEmptyEnv>,
  entityId: string,
  signerId: string,
  events: JurisdictionEvent[],
  blockNumber: number,
  blockHash: string,
  transactionHash: string,
) => {
  const eventsHash = canonicalJurisdictionEventsHash(events);
  const jurisdictionRef = getJEventJurisdictionRef(undefined);
  return { jurisdictionRef, eventsHash };
};

const buildSignedInput = (
  env: ReturnType<typeof createEmptyEnv>,
  entityId: string,
  signerId: string,
  event: JurisdictionEvent,
): LegacyJEventInput => ({
  from: signerId,
  event,
  events: [event],
  observedAt: 1_000 + Number(event.blockNumber ?? 0),
  blockNumber: Number(event.blockNumber ?? 0),
  blockHash: String(event.blockHash),
  transactionHash: String(event.transactionHash),
  ...signJEventInput(
    env,
    entityId,
    signerId,
    [event],
    Number(event.blockNumber ?? 0),
    String(event.blockHash),
    String(event.transactionHash),
  ),
});

describe('external wallet observed state', () => {
  test('signer wallet module rejects a non-validator external owner', () => {
    const signerId = `0x${'11'.repeat(20)}`;
    const foreignOwner = `0x${'44'.repeat(20)}`;
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const state = makeState(entityId, signerId);
    const event: ExternalWalletSnapshotEvent = {
      type: 'ExternalWalletSnapshot',
      blockNumber: 41,
      blockHash: `0x${'41'.repeat(32)}`,
      transactionHash: `0x${'91'.repeat(32)}`,
      data: {
        entityId,
        owner: foreignOwner,
        nativeBalance: '1',
      },
    };

    expect(() => applySignerEntityExternalWalletSnapshot(state, event, 41, `0x${'91'.repeat(32)}`))
      .toThrow('EXTERNAL_WALLET_OWNER_NOT_SIGNER');
    expect(state.externalWallet).toBeUndefined();
  });

  test('applies finalized wallet snapshot and preserves it through clone/storage projection', async () => {
    const seed = 'external-wallet-state';
    const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
    registerSignerKey(signerId, deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;

    const event: JurisdictionEvent = {
      type: 'ExternalWalletSnapshot',
      blockNumber: 42,
      blockHash: `0x${'42'.repeat(32)}`,
      transactionHash: 'external-wallet-snapshot:42:test',
      data: {
        entityId,
        owner: signerId,
        nativeBalance: '1000000000000000000',
        tokenBalances: [{ tokenAddress: TOKEN, tokenId: 7, balance: '2500' }],
        allowances: [{ tokenAddress: TOKEN, spender: SPENDER, allowance: '900' }],
      },
    };
    const input = buildSignedInput(env, entityId, signerId, event);

    const result = await applyJEventRange(makeState(entityId, signerId), input, env);
    const ownerState = result.newState.externalWallet?.balances.get(signerId);
    expect(ownerState?.get(NATIVE)?.balance).toBe(1_000_000_000_000_000_000n);
    expect(ownerState?.get(TOKEN)?.balance).toBe(2_500n);
    expect(ownerState?.get(TOKEN)?.tokenId).toBe(7);
    expect(result.newState.externalWallet?.allowances.get(signerId)?.get(`${TOKEN}:${SPENDER}`)?.allowance).toBe(900n);

    const cloned = cloneEntityState(result.newState);
    expect(cloned.externalWallet?.balances.get(signerId)?.get(TOKEN)?.balance).toBe(2_500n);

    const hydrated = hydrateEntityStateFromStorage({
      core: projectEntityCoreDoc(result.newState),
      accounts: new Map(),
      books: new Map(),
    });
    expect(hydrated.externalWallet?.balances.get(signerId)?.get(TOKEN)?.balance).toBe(2_500n);
  });

  test('entity frame hash commits to external wallet balances and allowances', async () => {
    const seed = 'external-wallet-frame-hash';
    const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const baseline = makeState(entityId, signerId);
    baseline.externalWallet = {
      balances: new Map([[signerId, new Map([
        [NATIVE, {
          tokenAddress: NATIVE,
          tokenId: 0,
          balance: 10n,
          jHeight: 10,
          transactionHash: `0x${'10'.repeat(32)}`,
        }],
        [TOKEN, {
          tokenAddress: TOKEN,
          tokenId: 7,
          balance: 2_500n,
          jHeight: 10,
          transactionHash: `0x${'10'.repeat(32)}`,
        }],
      ])]]),
      allowances: new Map([[signerId, new Map([[`${TOKEN}:${SPENDER}`, {
        tokenAddress: TOKEN,
        spender: SPENDER,
        allowance: 900n,
        jHeight: 10,
        transactionHash: `0x${'10'.repeat(32)}`,
      }]])]]),
    };
    const sameDataDifferentOrder = makeState(entityId, signerId);
    sameDataDifferentOrder.externalWallet = {
      balances: new Map([[signerId, new Map([
        [TOKEN, {
          tokenAddress: TOKEN,
          tokenId: 7,
          balance: 2_500n,
          jHeight: 10,
          transactionHash: `0x${'10'.repeat(32)}`,
        }],
        [NATIVE, {
          tokenAddress: NATIVE,
          tokenId: 0,
          balance: 10n,
          jHeight: 10,
          transactionHash: `0x${'10'.repeat(32)}`,
        }],
      ])]]),
      allowances: new Map([[signerId, new Map([[`${TOKEN}:${SPENDER}`, {
        tokenAddress: TOKEN,
        spender: SPENDER,
        allowance: 900n,
        jHeight: 10,
        transactionHash: `0x${'10'.repeat(32)}`,
      }]])]]),
    };
    const mutated = cloneEntityState(baseline);
    mutated.externalWallet!.balances.get(signerId)!.get(TOKEN)!.balance = 2_501n;

    const hashBaseline = await createEntityFrameHash('genesis', 1, 1_000, [], baseline);
    const hashSame = await createEntityFrameHash('genesis', 1, 1_000, [], sameDataDifferentOrder);
    const hashMutated = await createEntityFrameHash('genesis', 1, 1_000, [], mutated);

    expect(hashSame).toBe(hashBaseline);
    expect(hashMutated).not.toBe(hashBaseline);
  });

  test('applies wallet snapshot to a projection-shaped replica through canonical runtime input', async () => {
    const seed = 'external-wallet-runtime-input';
    const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
    registerSignerKey(signerId, deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const seededReplica: EntityReplica = {
      entityId,
      signerId,
      isProposer: true,
      state: makeState(entityId, signerId),
      mempool: [],
      hankoWitness: new Map(),
    };
    env.eReplicas.set(`${entityId}:${signerId}`, seededReplica);

    const input = buildJEventsRuntimeInput(env, [{
      name: 'ExternalWalletSnapshot',
      args: {
        entityId,
        owner: signerId,
        nativeBalance: '1000000000000000000',
        tokenBalances: [{ tokenAddress: TOKEN, tokenId: 7, balance: '2500' }],
        allowances: [{ tokenAddress: TOKEN, spender: SPENDER, allowance: '900' }],
      },
      blockNumber: 42,
      blockHash: `0x${'42'.repeat(32)}`,
      transactionHash: 'external-wallet-snapshot:42:runtime-input',
    }], 'external-wallet-runtime-input');

    expect(input).not.toBeNull();
    await applyRuntimeInput(env, input!);

    const replica = env.eReplicas.get(`${entityId}:${signerId}`);
    expect(replica?.mempool).toEqual([]);
    expect(replica?.state.externalWallet?.balances.get(signerId)?.get(TOKEN)?.balance).toBe(2_500n);
    expect(replica?.state.externalWallet?.allowances.get(signerId)?.get(`${TOKEN}:${SPENDER}`)?.allowance).toBe(900n);
  });

  test('applies ERC20 transfer and approval deltas only on top of a snapshot baseline', async () => {
    const seed = 'external-wallet-delta';
    const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
    registerSignerKey(signerId, deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;

    const snapshot: JurisdictionEvent = {
      type: 'ExternalWalletSnapshot',
      blockNumber: 42,
      blockHash: `0x${'42'.repeat(32)}`,
      transactionHash: 'external-wallet-snapshot:42:delta',
      data: {
        entityId,
        owner: signerId,
        tokenBalances: [{ tokenAddress: TOKEN, tokenId: 7, balance: '2500' }],
        allowances: [{ tokenAddress: TOKEN, spender: SPENDER, allowance: '900' }],
      },
    };
    const afterSnapshot = await applyJEventRange(makeState(entityId, signerId), buildSignedInput(env, entityId, signerId, snapshot), env);
    const delta: JurisdictionEvent = {
      type: 'ExternalWalletDelta',
      blockNumber: 43,
      blockHash: `0x${'43'.repeat(32)}`,
      transactionHash: `0x${'ab'.repeat(32)}`,
      data: {
        entityId,
        owner: signerId,
        tokenAddress: TOKEN,
        tokenId: 7,
        balanceDelta: '-400',
        spender: SPENDER,
        allowance: '700',
      },
    };

    const result = await applyJEventRange(afterSnapshot.newState, buildSignedInput(env, entityId, signerId, delta), env);
    expect(result.newState.externalWallet?.balances.get(signerId)?.get(TOKEN)?.balance).toBe(2_100n);
    expect(result.newState.externalWallet?.allowances.get(signerId)?.get(`${TOKEN}:${SPENDER}`)?.allowance).toBe(700n);
  });

  test('rejects wallet snapshot and delta for an external owner outside entity validators', async () => {
    const seed = 'external-wallet-non-signer-owner';
    const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const foreignOwner = deriveSignerAddressSync(seed, 'foreign').toLowerCase();
    registerSignerKey(signerId, deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;

    const snapshot: JurisdictionEvent = {
      type: 'ExternalWalletSnapshot',
      blockNumber: 42,
      blockHash: `0x${'42'.repeat(32)}`,
      transactionHash: 'external-wallet-snapshot:42:foreign-owner',
      data: {
        entityId,
        owner: foreignOwner,
        tokenBalances: [{ tokenAddress: TOKEN, tokenId: 7, balance: '2500' }],
      },
    };
    await expect(
      applyJEventRange(makeState(entityId, signerId), buildSignedInput(env, entityId, signerId, snapshot), env),
    ).rejects.toThrow('EXTERNAL_WALLET_OWNER_NOT_SIGNER');

    const stateWithForeignBaseline = makeState(entityId, signerId);
    stateWithForeignBaseline.externalWallet = {
      balances: new Map([[foreignOwner, new Map([[TOKEN, {
        tokenAddress: TOKEN,
        tokenId: 7,
        balance: 2_500n,
        jHeight: 42,
      }]])]]),
      allowances: new Map(),
    };
    const delta: JurisdictionEvent = {
      type: 'ExternalWalletDelta',
      blockNumber: 43,
      blockHash: `0x${'43'.repeat(32)}`,
      transactionHash: `0x${'cd'.repeat(32)}`,
      data: {
        entityId,
        owner: foreignOwner,
        tokenAddress: TOKEN,
        tokenId: 7,
        balanceDelta: '1',
      },
    };
    await expect(
      applyJEventRange(stateWithForeignBaseline, buildSignedInput(env, entityId, signerId, delta), env),
    ).rejects.toThrow('EXTERNAL_WALLET_OWNER_NOT_SIGNER');
  });

  test('rejects ERC20 delta without a committed wallet baseline', async () => {
    const seed = 'external-wallet-delta-missing';
    const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
    registerSignerKey(signerId, deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    const delta: JurisdictionEvent = {
      type: 'ExternalWalletDelta',
      blockNumber: 43,
      blockHash: `0x${'43'.repeat(32)}`,
      transactionHash: `0x${'bc'.repeat(32)}`,
      data: {
        entityId,
        owner: signerId,
        tokenAddress: TOKEN,
        tokenId: 7,
        balanceDelta: '1',
      },
    };

    await expect(
      applyJEventRange(makeState(entityId, signerId), buildSignedInput(env, entityId, signerId, delta), env),
    ).rejects.toThrow('EXTERNAL_WALLET_BASELINE_MISSING:balance');
  });
});
