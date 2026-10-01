// P-BELIEF: an Account's belief about the chain may lag it, but never holds a value the chain did not hold, nor goes back to an older one.
import { expect, test } from "bun:test";
import { unwrap } from "../../../xln_run.ts";
import { accountId, genesisReplica, tokenId } from "../../../xln.ts";
import type { AccountReplica, EntityId, Runtime } from "../../../xln.ts";
import { checkBelief, lagging, NOTHING_SEEN, watchSettled, type CollateralView, type Settled, type Trail } from "./belief.ts";

const L = `0x${"1".padStart(64, "0")}` as EntityId;
const R = `0x${"2".padStart(64, "0")}` as EntityId;
const TK = unwrap(tokenId("1"));
const TERMS = {
  domain: { chainId: 31337, depositoryAddress: `0x${"d".repeat(40)}` },
  watchSeed: `0x${"ab".repeat(32)}`,
  disputeConfig: { leftResponseSeconds: 60, rightResponseSeconds: 60 },
};
const genesis = unwrap(genesisReplica(unwrap(accountId(L, R)), TERMS));
/** The Account as Left holds it once it has learned this collateral and ondelta from the chain. */
const believing = (collateral: bigint, ondelta: bigint): Runtime => {
  const replica: AccountReplica = {
    ...genesis,
    state: {
      ...genesis.state,
      account: { ...genesis.state.account, deltas: new Map([[TK, { tokenId: TK, collateral, ondelta, offdelta: 0n, leftCreditLimit: 0n, rightCreditLimit: 0n }]]) },
    },
  };
  return ({ entities: new Map([[`${L}:a`, { state: { id: L }, accountReplicas: new Map([[R, replica]]) }]]) }) as unknown as Runtime;
};
const chainHolding = (collateral: bigint, ondelta: bigint): CollateralView => ({ getCollateral: async () => ({ collateral, ondelta }) });
const frame = async (chain: [bigint, bigint], belief: [bigint, bigint], before: Trail) =>
  checkBelief(chainHolding(...chain), believing(...belief), before);

test("P-BELIEF: a belief that lags the chain and then catches up is clean", async () => {
  const a = await frame([0n, 0n], [0n, 0n], NOTHING_SEEN);
  const b = await frame([100n, 0n], [0n, 0n], a.trail); // chain moved; the event is not observed yet
  const c = await frame([100n, 0n], [100n, 0n], b.trail);
  expect([a, b, c].flatMap((x) => x.violations)).toEqual([]);
});

test("P-BELIEF: a belief the chain never held is red (an event applied twice)", async () => {
  const a = await frame([100n, 0n], [0n, 0n], NOTHING_SEEN);
  const b = await frame([100n, 0n], [200n, 0n], a.trail);
  expect(b.violations).toHaveLength(1);
  expect(b.violations[0]).toContain("Account believes 200/0");
});

test("P-BELIEF: a belief that goes back to an older chain value is red", async () => {
  const a = await frame([100n, 0n], [0n, 0n], NOTHING_SEEN);
  const b = await frame([100n, 0n], [100n, 0n], a.trail);
  const c = await frame([250n, 0n], [250n, 0n], b.trail);
  const d = await frame([250n, 0n], [100n, 0n], c.trail);
  expect(d.violations).toHaveLength(1);
});

test("P-BELIEF: an Account that never learns a deposit stays clean until it does (lag is not a violation)", async () => {
  const a = await frame([100n, 0n], [0n, 0n], NOTHING_SEEN);
  const b = await frame([100n, 0n], [0n, 0n], a.trail);
  expect(b.violations).toEqual([]);
});

/** The same Account, whichever way its replica stands. */
const withTag = (rt: Runtime, _tag: AccountReplica["_tag"]): Runtime => {
  const [entity] = [...rt.entities.values()];
  const [peer, replica] = [...entity!.accountReplicas][0]!;
  return ({ entities: new Map([[`${L}:a`, { ...entity!, accountReplicas: new Map([[peer, { ...replica, _tag }]]) }]]) }) as unknown as Runtime;
};

test("P-BELIEF at rest: an Account whose dispute is live or finalized, which takes no more J events, may sit behind the chain", async () => {
  const chain = chainHolding(100n, 0n);
  expect(await lagging(chain, withTag(believing(0n, 0n), "disputed"))).toEqual([]);
});

test("P-BELIEF at rest: the same mismatch on an Account outside a dispute is still red, whatever frame it is in", async () => {
  const chain = chainHolding(100n, 0n);
  const behind = await Promise.all((["open", "proposed", "received", "preparing"] as const).map((tag) => lagging(chain, withTag(believing(0n, 0n), tag))));
  expect(behind.map((lines) => lines.length)).toEqual([1, 1, 1, 1]);
  expect(await lagging(chain, withTag(believing(100n, 0n), "open"))).toEqual([]);
});

const KEY = `${L}→${R} token 1`;
const MID: Settled = new Map([[KEY, [{ collateral: 100n, ondelta: 100n }, { collateral: 350n, ondelta: 100n }]]]);

test("P-BELIEF: the state between two ops of one batch is one the chain held, which a read after the block never sees", async () => {
  const a = await frame([0n, 0n], [0n, 0n], NOTHING_SEEN);
  // one block moved the chain from 0/0 to 350/100 through 100/100; the Account has applied the first row only
  const b = await checkBelief(chainHolding(350n, 100n), believing(100n, 100n), a.trail, MID);
  const c = await checkBelief(chainHolding(350n, 100n), believing(350n, 100n), b.trail, MID);
  expect([b, c].flatMap((x) => x.violations)).toEqual([]);
});

test("P-BELIEF: the same state with no row that announced it is red", async () => {
  const a = await frame([0n, 0n], [0n, 0n], NOTHING_SEEN);
  const b = await checkBelief(chainHolding(350n, 100n), believing(100n, 100n), a.trail);
  expect(b.violations).toHaveLength(1);
});

test("P-BELIEF: a row's state is held once: going back to it after a later row is red", async () => {
  const a = await checkBelief(chainHolding(350n, 100n), believing(350n, 100n), NOTHING_SEEN, MID);
  const b = await checkBelief(chainHolding(350n, 100n), believing(100n, 100n), a.trail, MID);
  expect(b.violations).toHaveLength(1);
});

test("watchSettled reads each AccountSettled row's collateral and ondelta, an Int512 as its two words", () => {
  const listeners: ((events: readonly { name: string; args: unknown }[]) => void)[] = [];
  const history = watchSettled({ onAny: (listener) => listeners.push(listener) });
  const rows = (ondelta: readonly [bigint, bigint]) => ({ settled: [[L, R, [[1n, 5n, 6n, 350n, ondelta]], 3n]] });
  listeners[0]!([{ name: "ReserveUpdated", args: {} }, { name: "AccountSettled", args: rows([0n, 100n]) }, { name: "AccountSettled", args: rows([-1n, 2n ** 256n - 1n]) }]);
  expect(history.get(KEY)).toEqual([{ collateral: 350n, ondelta: 100n }, { collateral: 350n, ondelta: -1n }]);
});
