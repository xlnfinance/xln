import { describe, expect, test } from 'bun:test';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey, signAccountFrame } from '../account-crypto';
import { buildJEventObservationDigest, canonicalJurisdictionEventsHash } from '../j-event-observation';
import { handleJEvent, type JEventEntityTxData } from '../entity-tx/j-events';
import { createEmptyEnv, generateLazyEntityId } from '../runtime';
import { cloneEntityState } from '../state-helpers';
import { hydrateEntityStateFromStorage, projectEntityCoreDoc } from '../storage/projections';
import type { ConsensusConfig, EntityState, JurisdictionEvent } from '../types';

const TOKEN = '0x2222222222222222222222222222222222222222';
const SPENDER = '0x3333333333333333333333333333333333333333';
const NATIVE = '0x0000000000000000000000000000000000000000';

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
  jBlockObservations: [],
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
  const signature = signAccountFrame(
    env,
    signerId,
    buildJEventObservationDigest({
      entityId,
      signerId,
      blockNumber,
      blockHash,
      transactionHash,
      eventsHash,
    }),
  );
  return { eventsHash, signature };
};

const buildSignedInput = (
  env: ReturnType<typeof createEmptyEnv>,
  entityId: string,
  signerId: string,
  event: JurisdictionEvent,
): JEventEntityTxData => ({
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

    const result = await handleJEvent(makeState(entityId, signerId), input, env);
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
    const afterSnapshot = await handleJEvent(makeState(entityId, signerId), buildSignedInput(env, entityId, signerId, snapshot), env);
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

    const result = await handleJEvent(afterSnapshot.newState, buildSignedInput(env, entityId, signerId, delta), env);
    expect(result.newState.externalWallet?.balances.get(signerId)?.get(TOKEN)?.balance).toBe(2_100n);
    expect(result.newState.externalWallet?.allowances.get(signerId)?.get(`${TOKEN}:${SPENDER}`)?.allowance).toBe(700n);
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
      handleJEvent(makeState(entityId, signerId), buildSignedInput(env, entityId, signerId, delta), env),
    ).rejects.toThrow('EXTERNAL_WALLET_BASELINE_MISSING:balance');
  });
});
