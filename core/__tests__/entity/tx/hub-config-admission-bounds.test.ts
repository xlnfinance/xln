import { describe, expect, test } from 'bun:test';

import { commitEntityFrameCandidateState } from '../../../entity/state-clone';
import { applyEntityTx } from '../../../entity/tx/apply';
import type { EntityState } from '../../../entity/types';
import { createEmptyEnv } from '../../../runtime';
import { keyLiveEntity } from '../../../storage/keys';
import { prepareEntityStorageLayout, readEntityStorageLayout } from '../../../storage/schema/entity/layout';
import type { EntityTx } from '../../../types/entity-tx';
import { MemoryRuntimeDb } from '../../fixtures/storage/memory-runtime-db';
import { addr, entity, makeJurisdiction, makeState } from '../../helpers/cross-j';

const entityId = entity('31');
const hubConfig = (data: Extract<EntityTx, { type: 'setHubConfig' }>['data']): EntityTx => ({
  type: 'setHubConfig',
  data,
});
const orderbookExt = (referenceTokenId: number, minTradeSize: bigint): EntityTx => ({
  type: 'initOrderbookExt',
  data: {
    name: 'bounds-hub',
    spreadDistribution: { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
    referenceTokenId,
    usdQuoteAuthorityEntityId: entity('32'),
    minTradeSize,
    supportedPairs: ['1/2'],
  },
});

const freshState = (): EntityState => makeState(entityId, addr('51'), makeJurisdiction('Bounds', 1, '11', '12'));

const roundTrip = async (state: EntityState) => {
  const db = new MemoryRuntimeDb();
  const committed = commitEntityFrameCandidateState(state);
  const layout = prepareEntityStorageLayout(entityId, keyLiveEntity(entityId), committed);
  const batch = db.batch();
  for (const row of layout.puts) batch.put(row.key, row.value);
  await batch.write();
  return (await readEntityStorageLayout(db, entityId, keyLiveEntity(entityId)))?.doc;
};

/**
 * The Entity document schema refuses a negative hub fee or threshold, token 0
 * as the orderbook reference and a negative minimum trade on every read. Live
 * admission used to commit them, so the Runtime could never restart. They are
 * now typed rejects (skippedError -> MalformedEntityFrameInputError) before
 * mutation; Rust parity: entity-kernel local_control.rs.
 */
describe('hub settings the Entity document cannot read back are rejected at admission', () => {
  const rejected: Array<[string, EntityTx, string]> = [
    ['negative baseFee', hubConfig({ baseFee: -1n }), 'HUB_CONFIG_BASE_FEE_NEGATIVE:-1'],
    [
      'negative minCollateralThreshold',
      hubConfig({ minCollateralThreshold: -1n }),
      'HUB_CONFIG_MIN_COLLATERAL_THRESHOLD_NEGATIVE:-1',
    ],
    ['referenceTokenId 0', orderbookExt(0, 0n), 'ORDERBOOK_REFERENCE_TOKEN_INVALID:0'],
    ['negative minTradeSize', orderbookExt(1, -1n), 'ORDERBOOK_MIN_TRADE_SIZE_NEGATIVE:-1'],
  ];
  for (const [name, tx, code] of rejected) {
    test(`${name} is a typed reject that leaves the Entity untouched`, async () => {
      const state = freshState();
      const result = await applyEntityTx(createEmptyEnv(`hub-bounds-${name}`), state, tx);
      expect(result.skippedError).toBe(code);
      expect(result.newState).toBe(state);
      expect(state.hubRebalanceConfig).toBeUndefined();
      expect(state.orderbookExt).toBeUndefined();
    });
  }

  // A signer's out-of-range hub setting used to be a plain Error inside the
  // Entity transition, which halted the Runtime that applied it.
  const signerErrors: Array<[string, EntityTx, string]> = [
    ['negative routingFeePPM', hubConfig({ routingFeePPM: -1 }), 'HUB_CONFIG_ROUTING_FEE_PPM_NEGATIVE:-1'],
    ['negative rebalanceTimeoutMs', hubConfig({ rebalanceTimeoutMs: -1 }), 'HUB_CONFIG_REBALANCE_TIMEOUT_MS_NEGATIVE:-1'],
    ['swapTakerFeeBps above 100%', hubConfig({ swapTakerFeeBps: 10_001 }), 'HUB_CONFIG_SWAP_TAKER_FEE_BPS_INVALID:10001'],
    ['negative swapTakerFeeBps', hubConfig({ swapTakerFeeBps: -1 }), 'HUB_CONFIG_SWAP_TAKER_FEE_BPS_INVALID:-1'],
    [
      'liquidity fee above 100%',
      hubConfig({ rebalanceLiquidityFeeBps: 10_001n }),
      'HUB_REBALANCE_LIQUIDITY_FEE_BPS_INVALID:10001',
    ],
    ['policyVersion 0', hubConfig({ policyVersion: 0 }), 'HUB_REBALANCE_POLICY_VERSION_INVALID:0'],
    [
      'tokenless raw override',
      hubConfig({ rebalanceBaseFee: 1n }),
      'HUB_REBALANCE_TOKENLESS_RAW_OVERRIDE_FORBIDDEN:rebalanceBaseFee',
    ],
  ];
  for (const [name, tx, code] of signerErrors) {
    test(`${name} is a typed reject, not a Runtime halt`, async () => {
      const state = freshState();
      const result = await applyEntityTx(createEmptyEnv(`hub-signer-${name}`), state, tx);
      expect(result.skippedError).toBe(code);
      expect(result.newState).toBe(state);
      expect(state.hubRebalanceConfig).toBeUndefined();
    });
  }

  test('a stale or equivocating policy version is a typed reject', async () => {
    const env = createEmptyEnv('hub-policy-version');
    const configured = await applyEntityTx(env, freshState(), hubConfig({ policyVersion: 4, rebalanceLiquidityFeeBps: 5n }));
    expect(configured.skippedError).toBeUndefined();
    const stale = await applyEntityTx(env, configured.newState, hubConfig({ policyVersion: 3, rebalanceLiquidityFeeBps: 5n }));
    expect(stale.skippedError).toBe('HUB_REBALANCE_POLICY_VERSION_STALE:3<4');
    const equivocation = await applyEntityTx(env, configured.newState, hubConfig({ policyVersion: 4, rebalanceLiquidityFeeBps: 6n }));
    expect(equivocation.skippedError).toBe('HUB_REBALANCE_POLICY_EQUIVOCATION:version=4');
  });

  test('the boundary values commit and round-trip through the Entity storage layout', async () => {
    const env = createEmptyEnv('hub-bounds-accept');
    const configured = await applyEntityTx(env, freshState(), hubConfig({ baseFee: 0n, minCollateralThreshold: 0n }));
    expect(configured.skippedError).toBeUndefined();
    const booked = await applyEntityTx(env, configured.newState, orderbookExt(1, 0n));
    expect(booked.skippedError).toBeUndefined();

    const doc = await roundTrip(booked.newState);
    expect(doc?.hubRebalanceConfig).toMatchObject({ baseFee: 0n, minCollateralThreshold: 0n });
    expect(doc?.orderbookHubProfile).toMatchObject({ referenceTokenId: 1, minTradeSize: 0n });

    // Storage keeps its own guard: the value admission now refuses is exactly
    // the one that made the committed Entity document unreadable.
    const corrupt = await applyEntityTx(env, freshState(), hubConfig({ baseFee: 0n }));
    corrupt.newState.hubRebalanceConfig = { ...corrupt.newState.hubRebalanceConfig!, baseFee: -1n };
    await expect(roundTrip(corrupt.newState)).rejects.toThrow('STORAGE_ENTITY_DOC_INVALID_HUB_REBALANCE_CONFIG_BASE_FEE');
  });
});
