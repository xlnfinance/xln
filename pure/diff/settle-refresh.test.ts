import { afterAll, describe, expect, test } from "bun:test";
// Runtime-loop differential for og refreshStaleUncommittedSettlementHankos (core/entity/consensus/frame/
// application.ts) followed, in the same Entity frame, by materializeDeferredSettlementApprovals (both from
// drainPostOrderbookAccountWork). og's own comment names the case: a same-height Account tiebreaker restores our
// uncommitted settle hanko after the winning peer frame advanced the proof nonce.
//
// A scripted run (fixed inputs, no walk) on one spoke-hub Account, L the left (lower id) side and R the right:
//   1. L proposes a settlement workspace that forgives (never auto-approved: og canAutoApproveWorkspace);
//   2. one Runtime frame carries L's direct payment and R's settle_approve: L proposes the payment frame, and R's
//      Account is idle, so og materializes the approval at once and R proposes its hanko frame, at the same height;
//   3. next frame, each side receives the other's proposal: L (left) wins and ignores R's; R rolls back
//      (og applySameHeightIncomingFrameRollback), restores the hanko, commits L's frame (the proof nonce moves on) and
//      acks. Its restored hanko is now nonce-stale, so the refresh drops it and re-defers the approval, and the
//      materialize check, reading the mempool the refresh just emptied, signs the approval again in that frame.
//      og's filter reaches only the Entity's TypeScript view: its Account worker's post-account
//      (rscore/ts-worker/provider.ts materializeOutboundAccounts) keeps the stale hanko queued behind the fresh one;
//   4. once the fresh hanko commits (nonceAtSign set), the stale one is no longer refreshable
//      (og isRefreshableStaleSettlementHanko), so proposing it is critical: og throwCriticalProposalFailure halts the
//      Runtime with SETTLEMENT_TRANSITION_PROPOSAL_FAILED:hanko:SETTLEMENT_HANKO_NONCE_MISMATCH, and so does the rewrite.
// The lane compares og processRuntime with the rewrite's commitRuntimeFrame on every frame, before and after.
import { entityLog } from "../../core/entity/consensus/entity-log.ts";
import { replicaKey, stableJson, type EntityId, type EntityTx } from "../xln.ts";
import { SIGNERS, type User } from "./lane.ts";
import { HUB, openWorld, SPOKES, type World } from "./world.ts";

/** The seed only draws the spokes' opening credit; every step below is fixed. */
const SEED = 0x5e771e;
/** Idle frames allowed for one step's Account work to settle. */
const DRAIN = 8;
/** Frames after the tiebreak within which the stale hanko reaches a proposal. */
const HALT_WITHIN = 6;

/** og's settlement.stale_hanko_refreshed fields, captured from its Entity logger (og logs it at info). */
type Refreshed = { readonly account: string; readonly expectedNonce: number; readonly staleNonces: readonly number[] };
const refreshes: Refreshed[] = [];
const ogInfo = entityLog.info;
// monkeypatch og's logger (og is never edited): record the refresh, then log as og would
entityLog.info = (message, fields) => {
  if (message === "settlement.stale_hanko_refreshed") refreshes.push(fields as unknown as Refreshed);
  ogInfo(message, fields);
};
afterAll(() => {
  entityLog.info = ogInfo;
});

type OgTx = { readonly type: string; readonly data?: { readonly kind?: string; readonly settlementNonce?: number } };
type OgAccount = {
  readonly mempool?: readonly OgTx[];
  readonly pendingFrame?: { readonly accountTxs: readonly OgTx[] };
  readonly state?: { readonly settlementWorkspace?: { readonly workspaceHash: string } };
};
type RwTx = { readonly type: string; readonly kind?: string; readonly settlementNonce?: number };
type RwAccount = {
  readonly _tag: string;
  readonly mempool: readonly RwTx[];
  readonly candidate?: { readonly frame: { readonly txs: readonly RwTx[] } };
};

const tx = (type: string, data: unknown): EntityTx => ({ type, data }) as unknown as EntityTx;
const ogAccount = (w: World, x: number, y: number): OgAccount | undefined => w.ogAccount(x, y) as never;
/** og's settle hanko nonces on one side of an Account: in its proposed frame, then in its mempool. */
const ogHankos = (w: World, x: number, y: number): readonly number[] => {
  const a = ogAccount(w, x, y);
  const txs = [...(a?.pendingFrame?.accountTxs ?? []), ...(a?.mempool ?? [])];
  return txs
    .filter((t) => t.type === "settle_transition" && t.data?.kind === "hanko")
    .map((t) => t.data!.settlementNonce!);
};
/** The rewrite's settle hanko nonces on one side of an Account, in the same order. */
const rwHankos = (w: World, x: number, y: number): readonly number[] => {
  const entity = w.lane.runtime().entities.get(replicaKey(w.ids[x]!, SIGNERS[x]!)) as unknown as
    | { readonly accountReplicas?: ReadonlyMap<EntityId, RwAccount> }
    | undefined;
  const a = entity?.accountReplicas?.get(w.ids[y]!);
  const txs = [...(a?._tag === "proposed" ? a.candidate!.frame.txs : []), ...(a?.mempool ?? [])];
  return txs.filter((t) => t.type === "settle_transition" && t.kind === "hanko").map((t) => t.settlementNonce!);
};
/** Idle frames, each compared, until both Runtimes halt on the same frame (at most `left` frames). */
const untilHalt = async (w: World, left: number): Promise<string> => {
  if (left === 0) return "no halt";
  const diffs = await w.lane.tick([], []);
  if (diffs.length > 0) return diffs.join("\n");
  return w.coverage.halts > 0 ? `frame=${w.lane.frames()} agreed halt` : untilHalt(w, left - 1);
};
/** Neither side of the Account holds a proposed frame or queued Account work. */
const idle = (w: World, x: number, y: number): boolean =>
  [ogAccount(w, x, y), ogAccount(w, y, x)].every((a) => a?.pendingFrame == null && (a?.mempool ?? []).length === 0);

describe("settle refresh: og refreshStaleUncommittedSettlementHankos then materializeDeferredSettlementApprovals", () => {
  test("MATCH: a hanko restored by a lost same-height tiebreak is nonce-stale; og and the rewrite re-sign the approval in that Entity frame, keep the stale hanko queued, and halt when it is proposed", async () => {
    const w = await openWorld(SEED, "settle-refresh");
    const step = async (users: readonly User[]): Promise<readonly string[]> => w.lane.tick([], users);
    /** Idle frames until the Account is idle (at most DRAIN), each compared like any other. */
    const drain = async (x: number, y: number, left: number): Promise<readonly string[]> => {
      if (left === 0 || idle(w, x, y)) return [];
      const diffs = await step([]);
      return diffs.length > 0 ? diffs : drain(x, y, left - 1);
    };
    try {
      const [imports, opens] = w.importAll();
      expect(await w.lane.tick(imports, [])).toEqual([]);
      expect(await step(opens)).toEqual([]);
      const spoke = SPOKES[0];
      expect(await drain(spoke, HUB, DRAIN)).toEqual([]);
      expect(w.hasAccount(spoke, HUB) && w.hasAccount(HUB, spoke)).toBe(true);
      // og isLeftEntity: the lower id is left; R must lose the tiebreak, so the approval is R's
      const [L, R] = w.ids[spoke]! < w.ids[HUB]! ? [spoke, HUB] : [HUB, spoke];
      // credit both ways, so L's payment has capacity whichever side is the hub
      expect(await step([w.user(L, [w.extend(L, R, 50_000n)])])).toEqual([]);
      expect(await drain(L, R, DRAIN)).toEqual([]);
      expect(await step([w.user(R, [w.extend(R, L, 50_000n)])])).toEqual([]);
      expect(await drain(L, R, DRAIN)).toEqual([]);
      // 1. L's workspace; forgiveness is never auto-approved, so R holds no hanko yet
      const propose = tx("settle_propose", { counterpartyEntityId: w.ids[R], ops: [{ type: "forgive", tokenId: 1 }], memo: "refresh" });
      expect(await step([w.user(L, [propose])])).toEqual([]);
      expect(await drain(L, R, DRAIN)).toEqual([]);
      const workspaceHash = ogAccount(w, R, L)?.state?.settlementWorkspace?.workspaceHash;
      expect(workspaceHash).toBeDefined();
      expect([...ogHankos(w, R, L), ...ogHankos(w, L, R)]).toEqual([]);
      // 2. the same Runtime frame: L's payment and R's approval, each proposed at the same Account height
      const approve = tx("settle_approve", { counterpartyEntityId: w.ids[L], workspaceHash });
      const race = [w.user(L, [w.direct(L, R, 5n)]), w.user(R, [approve])];
      expect(await step(race)).toEqual([]);
      const signed = ogHankos(w, R, L);
      expect(signed).toHaveLength(1);
      expect(ogAccount(w, R, L)?.pendingFrame?.accountTxs.map((t) => t.type)).toEqual(["settle_transition"]);
      expect(ogAccount(w, L, R)?.pendingFrame?.accountTxs.map((t) => t.type)).toEqual(["direct_payment"]);
      expect(refreshes).toEqual([]);
      // 3. the tiebreak frame: og's refresh fires on R's Account, and R's approval re-signs in the same frame
      const tie = await step([]);
      const resigned = ogHankos(w, R, L);
      // og logs the refresh once per Entity frame attempt; every attempt drops the same stale nonce
      expect(refreshes.length).toBeGreaterThan(0);
      expect(refreshes.every((r) => stableJson(r) === stableJson(refreshes[0]))).toBe(true);
      expect(refreshes[0]!.staleNonces).toEqual(signed);
      expect(ogAccount(w, R, L)?.pendingFrame?.accountTxs.map((t) => t.data?.settlementNonce)).toEqual([refreshes[0]!.expectedNonce]);
      expect(tie).toEqual([]);
      // R proposes the fresh hanko, and its committed Account keeps the stale one queued (og's worker post-account)
      expect(resigned).toEqual([refreshes[0]!.expectedNonce, ...signed]);
      expect(rwHankos(w, R, L)).toEqual(resigned);
      // after it: the frames run on until the stale hanko is proposed against a signed workspace, where og halts
      const halt = await untilHalt(w, HALT_WITHIN);
      console.log(`refresh ${stableJson(refreshes[0])}; hankos ${stableJson(signed)} -> ${stableJson(resigned)}; ${halt}`);
      expect(halt).toBe(`frame=${w.lane.frames()} agreed halt`);
      expect(w.coverage.haltTexts.at(-1)).toContain(`SETTLEMENT_HANKO_NONCE_MISMATCH:${refreshes[0]!.expectedNonce}:${signed[0]}`);
      expect(w.refusals()).toEqual([]);
    } finally {
      await w.close();
    }
  }, 600_000);
});
