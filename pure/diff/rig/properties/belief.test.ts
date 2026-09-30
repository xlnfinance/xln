// P3: an Account's belief about the chain may lag it, but never holds a value the chain did not hold, nor goes back to an older one.
import { expect, test } from "bun:test";
import { unwrap } from "../../../xln_run.ts";
import { accountId, genesisReplica, tokenId } from "../../../xln.ts";
import type { AccountReplica, EntityId, Runtime } from "../../../xln.ts";
import { checkBelief, lagging, NOTHING_SEEN, type CollateralView, type Trail } from "./belief.ts";

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

test("P3: a belief that lags the chain and then catches up is clean", async () => {
  const a = await frame([0n, 0n], [0n, 0n], NOTHING_SEEN);
  const b = await frame([100n, 0n], [0n, 0n], a.trail); // chain moved; the event is not observed yet
  const c = await frame([100n, 0n], [100n, 0n], b.trail);
  expect([a, b, c].flatMap((x) => x.violations)).toEqual([]);
});

test("P3: a belief the chain never held is red (an event applied twice)", async () => {
  const a = await frame([100n, 0n], [0n, 0n], NOTHING_SEEN);
  const b = await frame([100n, 0n], [200n, 0n], a.trail);
  expect(b.violations).toHaveLength(1);
  expect(b.violations[0]).toContain("Account believes 200/0");
});

test("P3: a belief that goes back to an older chain value is red", async () => {
  const a = await frame([100n, 0n], [0n, 0n], NOTHING_SEEN);
  const b = await frame([100n, 0n], [100n, 0n], a.trail);
  const c = await frame([250n, 0n], [250n, 0n], b.trail);
  const d = await frame([250n, 0n], [100n, 0n], c.trail);
  expect(d.violations).toHaveLength(1);
});

test("P3: an Account that never learns a deposit stays clean until it does (lag is not a violation)", async () => {
  const a = await frame([100n, 0n], [0n, 0n], NOTHING_SEEN);
  const b = await frame([100n, 0n], [0n, 0n], a.trail);
  expect(b.violations).toEqual([]);
});

/** The same Account, whichever way its replica stands. */
const withTag = (rt: Runtime, _tag: "open" | "disputed"): Runtime => {
  const [entity] = [...rt.entities.values()];
  const [peer, replica] = [...entity!.accountReplicas][0]!;
  return ({ entities: new Map([[`${L}:a`, { ...entity!, accountReplicas: new Map([[peer, { ...replica, _tag }]]) }]]) }) as unknown as Runtime;
};

test("P3 at rest: an open Account behind the chain is red; a disputed one, which takes no more J events, is not", async () => {
  const chain = chainHolding(100n, 0n);
  expect(await lagging(chain, withTag(believing(0n, 0n), "open"))).toHaveLength(1);
  expect(await lagging(chain, withTag(believing(0n, 0n), "disputed"))).toEqual([]);
  expect(await lagging(chain, withTag(believing(100n, 0n), "open"))).toEqual([]);
});
