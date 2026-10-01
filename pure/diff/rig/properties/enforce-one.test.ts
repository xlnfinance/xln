// Reviewer A of #69: enforceOne (P1's whole lifecycle) against a fake World and a fake chain, so the composition is judged and not only payoutLines.
// The fake walks the real sequence: prepareDispute freezes the Account, the batch drafts a start, the broadcast queues it, DisputeStarted sets the
// timeout, the clock jump finalizes (the chain pays), and both sides close. A chain that pays wrong, or an Account the chain disagrees with at
// the freeze, must come back red; an Account holding a clause, or none ready, is skipped, never checked.
import { expect, test } from "bun:test";
import { unwrap } from "../../../xln_run.ts";
import { accountId, genesisReplica, tokenId } from "../../../xln.ts";
import type { AccountReplica, EntityId } from "../../../xln.ts";
import { HUB, SPOKES, type World } from "../world.ts";
import { enforceOne } from "./enforce.ts";

const TK = unwrap(tokenId("1"));
const IDS = [0, 1, 2, 3].map((i) => `0x${String(i + 1).padStart(64, "0")}` as EntityId);
const TERMS = {
  domain: { chainId: 31337, depositoryAddress: `0x${"d".repeat(40)}` },
  watchSeed: `0x${"ab".repeat(32)}`,
  disputeConfig: { leftResponseSeconds: 60, rightResponseSeconds: 60 },
};
const SPOKE = SPOKES[0]!;
const [LEFT, RIGHT] = IDS[SPOKE]! < IDS[HUB]! ? [IDS[SPOKE]!, IDS[HUB]!] : [IDS[HUB]!, IDS[SPOKE]!];
const genesis = unwrap(genesisReplica(unwrap(accountId(LEFT, RIGHT)), TERMS));

type Plan = {
  /** What the chain's collateral holds before the dispute; the Account believes 100. */
  collateral: bigint;
  /** What each side's reserve is after the finalize. */
  paid: { left: bigint; right: bigint };
  clause: "lock" | "offer" | "pull" | "settlement" | undefined;
};
const HONEST: Plan = { collateral: 100n, paid: { left: 970n, right: 1130n }, clause: undefined };

/** A World that only enforceOne's reads and ticks can see, whose chain pays as the plan says once the clock jumps. */
const fakeWorld = (plan: Plan, ready = true): World => {
  const stage = { n: 0 };
  const books = { collateral: plan.collateral, left: 1000n, right: 1000n };
  const replica = (): AccountReplica => ({
    ...genesis,
    _tag: stage.n === 0 ? "open" : "disputed",
    dispute: { ...genesis.dispute, ...(ready ? { counterparty: { hanko: "0x", hash: "0x", proofBodyHash: "0x", proofNonce: 1, proposerIsLeft: true } } : {}) },
    state: {
      ...genesis.state,
      locks: new Map(plan.clause === "lock" ? [["k", {}]] : []),
      offers: new Map(plan.clause === "offer" ? [["k", {}]] : []),
      pulls: new Map(plan.clause === "pull" ? [["k", {}]] : []),
      settlement: plan.clause === "settlement" ? { status: "awaiting_counterparty" } : undefined,
      account: {
        ...genesis.state.account,
        deltas: new Map([[TK, { tokenId: TK, ondelta: 0n, collateral: 100n, offdelta: -30n, leftCreditLimit: 50n, rightCreditLimit: 0n }]]),
      },
    },
  } as unknown as AccountReplica);
  const entity = (self: EntityId, peer: EntityId) => ({ state: { id: self }, accountReplicas: new Map([[peer, replica()]]) });
  const chain = {
    getCollateral: async () => ({ collateral: books.collateral, ondelta: 0n }),
    getReserves: async (id: string) => (id === LEFT ? books.left : books.right),
    getDebts: async () => [],
  };
  return {
    ids: IDS,
    ri: () => 0,
    lane: {
      runtime: () => ({ entities: new Map([[`${IDS[SPOKE]}:a`, entity(IDS[SPOKE]!, IDS[HUB]!)]]) }),
      tick: async () => { stage.n = Math.min(stage.n + 1, 2); return []; },
      jumpClock: () => { stage.n = 3; books.collateral = 0n; books.left = plan.paid.left; books.right = plan.paid.right; },
    },
    ogAccount: (x: number, y: number) =>
      (stage.n >= 3
        ? { status: "disputed", activeDispute: undefined }
        : { status: stage.n === 0 ? "active" : "disputed", counterpartyDisputeProofHanko: "0x", activeDispute: stage.n >= 2 ? { disputeTimeout: 5 } : undefined, x, y }),
    batchOf: () => ({ batch: { disputeStarts: stage.n >= 1 ? [{}] : [] }, sentBatch: undefined }),
    user: (x: number, txs: unknown) => ({ entity: x, txs }),
    chain: { pollNow: async () => undefined, getBrowserVM: () => chain },
  } as unknown as World;
};

test("enforceOne: an honest finalize is checked and clean", async () => {
  const done = await enforceOne(fakeWorld(HONEST));
  expect(done).toEqual({ _tag: "checked", spoke: SPOKE, lines: [] });
});

test("enforceOne: a chain that pays a side short comes back red (the payout is judged, not skipped)", async () => {
  const done = await enforceOne(fakeWorld({ ...HONEST, paid: { left: 970n, right: 1100n } }));
  expect(done).toMatchObject({ _tag: "checked" });
  expect((done as { lines: readonly string[] }).lines.some((l) => l.includes("the chain paid"))).toBe(true);
});

test("enforceOne: collateral the chain holds differently from the Account's belief at the freeze is red", async () => {
  const done = await enforceOne(fakeWorld({ ...HONEST, collateral: 90n, paid: { left: 970n, right: 1120n } }));
  expect((done as { lines: readonly string[] }).lines.some((l) => l.includes("Account believes collateral 100"))).toBe(true);
});

test("enforceOne: an Account holding a clause is never sampled (it resolves on chain by evidence the check does not model)", async () => {
  const clauses = ["lock", "offer", "pull", "settlement"] as const;
  const done = await Promise.all(clauses.map((clause) => enforceOne(fakeWorld({ ...HONEST, clause }))));
  expect(done.map((d) => (d as { _tag: string })._tag)).toEqual(["skipped", "skipped", "skipped", "skipped"]);
});

test("enforceOne: no hanko from the peer, no dispute to sample", async () => {
  expect(await enforceOne(fakeWorld(HONEST, false))).toMatchObject({ _tag: "skipped" });
});
