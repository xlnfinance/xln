/** Signed native same-J partial fill, then bilateral cancellation of its remainder. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveDelta, isLeftEntity } from '../../../../account/utils';
import { validateAccountDeltas } from '../../../../account/validation/delta-validation';
import { deriveSwapFillPolicyFee, deriveSwapNetAuthorization } from '../../../../account/swap/swap-net-authorization';
import { getStaticSwapTokenDimensions, getSwapLotScale } from '../../../../orderbook';
import { requireBoundaryInteger, requireBoundaryRecord } from '../../../../protocol/boundary-validation';
import { safeStringify } from '../../../../protocol/serialization';
import type { EntityTx } from '../../../../types/entity-tx';
import { connectRuntime, readWithRateLimitRetry, PRODUCTION_SWAP_LOAD_PAIR_ID, type ConnectedRuntime } from '../worker-runtime';
import { queueLaneRuntimeInputWave, type LaneRuntime } from '../lanes/lane-runtimes';
import { deriveExecutableBidForAsk } from '../boundary/worker-book-boundary';
import type { PreparedParallelSameLoad } from '../workload/worker-same-lanes';
import { fetchNativeJson, type RustH1Handle } from './rust-h1';

const record = (value: unknown) => requireBoundaryRecord(value, 'NATIVE_PARTIAL_BOUNDARY');
function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`NATIVE_PARTIAL_${label}`);
};
const wait = async <T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
  const deadline = Date.now() + 10_000;
  let value: T;
  do {
    value = await read();
    if (ready(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`NATIVE_PARTIAL_${label}:${safeStringify(value)}`);
};
const userAccount = async (runtime: ConnectedRuntime, lane: LaneRuntime, hub: string) => {
  const page = record(await readWithRateLimitRetry(runtime, `entity/${lane.identity.entityId}/accounts`, { accountId: hub, accountsLimit: 1 }));
  assert(Array.isArray(page['items']) && page['items'].length === 1, 'ACCOUNT_CARDINALITY');
  const row = record(page['items'][0]);
  const state = record(row['state']);
  const deltas = validateAccountDeltas(state['deltas'], 'native partial');
  assert(state['swapOffers'] instanceof Map, 'OFFERS_MISSING');
  return { height: requireBoundaryInteger(row['currentHeight'], 'NATIVE_PARTIAL_HEIGHT'),
    ready: row['pendingFrame'] === undefined && row['mempoolCount'] === 0,
    offers: state['swapOffers'] as Map<string, unknown>, deltas };
};
const balance = (view: Awaited<ReturnType<typeof userAccount>>, lane: LaneRuntime, hub: string, token: number) => {
  const delta = view.deltas.get(token);
  assert(delta, 'DELTA_MISSING');
  const derived = deriveDelta(delta, isLeftEntity(lane.identity.entityId, hub));
  return derived.outCapacity + derived.outTotalHold;
};
const submit = (lane: LaneRuntime, tx: EntityTx) => queueLaneRuntimeInputWave(0, [{ lane, input: {
  runtimeTxs: [], entityInputs: [{ entityId: lane.identity.entityId, signerId: lane.identity.signerId, entityTxs: [tx] }],
} }]);

export const runRustH1SwapPartialSmoke = async (options: {
  prepared: PreparedParallelSameLoad; rust: RustH1Handle; portBase: number; workDir: string;
}) => {
  const { prepared, rust } = options;
  const hub = rust.ready.entityId;
  const api = `http://127.0.0.1:${options.portBase + 10}`;
  // Reuse each worker's existing full capability only for its exact audience.
  // Former buyers now own base; former sellers own quote. No extra faucet.
  const pick = (giveToken: number) => {
    const lane = prepared.traderRuntimes.find((lane, i) => {
      const first = prepared.traderPlans[i]?.offers[0];
      return lane.port === Number(new URL(lane.hostIngress.baseUrl).port) &&
        first?.type === 'placeSwapOffer' && first.data.giveTokenId === giveToken;
    });
    assert(lane, `FUNDED_LANE_MISSING_${giveToken}`);
    return lane;
  };
  const maker = pick(1), taker = pick(2);
  const connect = (lane: LaneRuntime) => connectRuntime({ label: 'partial-cancel-user', engine: 'ts',
    wsUrl: `ws://127.0.0.1:${lane.port}/rpc`, token: lane.hostIngress.authKey });
  const makerRuntime = await connect(maker), takerRuntime = await connect(taker);
  try {
    assert(makerRuntime.adapter.runtimeId === maker.runtimeId && takerRuntime.adapter.runtimeId === taker.runtimeId, 'USER_IDENTITY');
    const book = async () => {
      const response = record(await fetchNativeJson(`${api}/api/market/snapshots?hubEntityId=${hub}&pairId=${encodeURIComponent(PRODUCTION_SWAP_LOAD_PAIR_ID)}&depth=100`));
      assert(Array.isArray(response['snapshots']) && response['snapshots'].length === 1, 'BOOK_CARDINALITY');
      return record(response['snapshots'][0]);
    };
    const beforeBook = await book();
    assert(Array.isArray(beforeBook['bids']) && Array.isArray(beforeBook['asks']), 'BOOK_SIDES');
    const bid = BigInt(String(record(beforeBook['bids'][0])['price']));
    const ask = BigInt(String(record(beforeBook['asks'][0])['price']));
    const price = (bid + ask) / 2n;
    assert(bid < price && price < ask, 'INDEPENDENT_SPREAD');
    const { baseAmount, quoteAmount } = deriveExecutableBidForAsk(2, 1, rust.ready.orderbookMinTradeSize, price);
    const profile = record(await fetchNativeJson(`${api}/api/gossip/profile?entityId=${hub}`));
    assert(profile['ok'] === true && profile['found'] === true, 'HUB_PROFILE');
    const feeBps = requireBoundaryInteger(record(record(profile['profile'])['metadata'])['swapTakerFeeBps'], 'NATIVE_PARTIAL_FEE');
    const makerId = `partial-maker-${rust.ready.runtimeId.slice(-8)}`;
    const takerId = `partial-taker-${rust.ready.runtimeId.slice(-8)}`;
    const makerBefore = await userAccount(makerRuntime, maker, hub), takerBefore = await userAccount(takerRuntime, taker, hub);
    assert(makerBefore.ready && takerBefore.ready, 'INITIAL_NOT_QUIESCENT');
    const makeOffer = (offerId: string, giveTokenId: number, giveAmount: bigint, wantTokenId: number, wantAmount: bigint): EntityTx => ({
      type: 'placeSwapOffer', data: { counterpartyEntityId: hub, offerId, giveTokenId, giveAmount, wantTokenId, wantAmount,
        ...getStaticSwapTokenDimensions(giveTokenId, wantTokenId), ...deriveSwapNetAuthorization(wantAmount, feeBps) },
    });
    const rowForMaker = (snapshot: Record<string, unknown>) => {
      assert(Array.isArray(snapshot['asks']), 'BOOK_ASKS');
      return snapshot['asks'].map(record).find(row => Array.isArray(row['orderIds']) && row['orderIds'].includes(`${maker.identity.entityId}:${makerId}`));
    };
    await submit(maker, makeOffer(makerId, 2, baseAmount * 3n, 1, quoteAmount * 3n));
    await wait('MAKER_NOT_RESTING', book, snapshot => BigInt(String(rowForMaker(snapshot)?.['size'] ?? '-1')) === baseAmount * 3n / getSwapLotScale(2));
    await submit(taker, makeOffer(takerId, 1, quoteAmount, 2, baseAmount));
    const makerPartial = await wait('PARTIAL_NOT_COMMITTED', () => userAccount(makerRuntime, maker, hub), view => {
      const offer = view.offers.get(makerId);
      return view.ready && offer !== undefined && record(offer)['giveAmount'] === baseAmount * 2n;
    });
    assert(record(makerPartial.offers.get(makerId))['wantAmount'] === quoteAmount * 2n, 'EXACT_QUOTE_REMAINDER');
    const takerFilled = await wait('TAKER_NOT_CLOSED', () => userAccount(takerRuntime, taker, hub), view => view.ready && !view.offers.has(takerId) && view.height > takerBefore.height);
    const fee = deriveSwapFillPolicyFee({ giveAmount: quoteAmount, wantAmount: baseAmount }, quoteAmount, baseAmount, feeBps, true);
    const assertMoney = (makerNow: typeof makerBefore, takerNow: typeof takerBefore) => {
      for (const [lane, before, after, token, expected] of [
        [maker, makerBefore, makerNow, 2, -baseAmount], [maker, makerBefore, makerNow, 1, quoteAmount],
        [taker, takerBefore, takerNow, 1, -quoteAmount], [taker, takerBefore, takerNow, 2, baseAmount - fee],
      ] as const) assert(balance(after, lane, hub, token) - balance(before, lane, hub, token) === expected, `EXACT_EXECUTION_${token}`);
    };
    assertMoney(makerPartial, takerFilled);
    await wait('BOOK_REMAINDER', book, snapshot => BigInt(String(rowForMaker(snapshot)?.['size'] ?? '-1')) === baseAmount * 2n / getSwapLotScale(2));
    await submit(maker, { type: 'proposeCancelSwap', data: { counterpartyEntityId: hub, offerId: makerId } });
    const makerFinal = await wait('CANCEL_NOT_COMMITTED', () => userAccount(makerRuntime, maker, hub), view => view.ready && !view.offers.has(makerId) && view.height > makerPartial.height);
    const takerFinal = await userAccount(takerRuntime, taker, hub);
    assertMoney(makerFinal, takerFinal);
    const finalBook = await wait('BOOK_NOT_CLEANED', book, snapshot => rowForMaker(snapshot) === undefined);
    for (const [lane, user] of [[maker, makerFinal], [taker, takerFinal]] as const) {
      const native = await wait('HUB_NOT_QUIESCENT', async () => record(await fetchNativeJson(`${api}/api/account/status?hubEntityId=${hub}&counterpartyEntityId=${lane.identity.entityId}&tokenIds=1,2`)), row => row['ready'] === true && row['currentHeight'] === user.height);
      assert(Array.isArray(native['tokens']), 'HUB_TOKENS');
      for (const entry of native['tokens']) {
        const token = record(entry), delta = record(token['delta']);
        const local = user.deltas.get(Number(token['tokenId']));
        assert(local && local.offdelta === BigInt(String(delta['offdelta'])), 'BILATERAL_DELTA');
        assert(local.leftHold === 0n && local.rightHold === 0n && delta['leftHold'] === '0' && delta['rightHold'] === '0', 'HOLD_NOT_RELEASED');
      }
    }
    const report = { engine: 'rust', makerId, takerId, executedBase: baseAmount, executedQuote: quoteAmount, fee,
      cancelledBase: baseAmount * 2n, cancelledQuote: quoteAmount * 2n, makerHeight: makerFinal.height,
      takerHeight: takerFinal.height, beforeBook, finalBook,
      economicSnapshots: {
        maker: { before: makerBefore.deltas, partial: makerPartial.deltas, final: makerFinal.deltas },
        taker: { before: takerBefore.deltas, filled: takerFilled.deltas, final: takerFinal.deltas },
      } };
    writeFileSync(join(options.workDir, 'native-same-partial-cancel.json'), `${safeStringify(report, 2)}\n`);
    console.log('[load] native same partial cancel GREEN');
  } finally { makerRuntime.adapter.disconnect(); takerRuntime.adapter.disconnect(); }
};
