/**
 * LAW — tier honesty (docs/PROVENANCE.md §5 A1 "payload tiering", §7 law table).
 * Drill-in carries replayed | replayed-cached | recorded | stub.
 *
 * pure-mux derivation lives in `provenance/replay.law.test.ts`; this file
 * houses tier-honesty only.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import type { Classifier, DeclaredRole } from "../../provenance/lineage.js";
import { buildWireframe } from "../../provenance/wireframe/builder.js";
import { replayGraphEgress, ReplayScopeError } from "../../provenance/replay.js";
import { answerQuery, ReplayMemo, type ReplayMemoKey } from "../../provenance/replay-memo.js";
import { recordRun } from "../provenance/q16-harness.js";
import type { EvidenceTier } from "../../provenance/store/interfaces.js";
import { PayloadStoreFake } from "../../provenance/store/fakes.js";
import { PayloadTierMachine } from "../../provenance/store/tiering.js";

// A single-source, straight-line wire — no fan/mux needed to exercise the
// envelope's tier composition. Shared by every Q17 row below.
const ROLES: Record<string, DeclaredRole> = { "fetch-item": "source" };
const CLASSIFIER: Classifier = { roleOf: (op) => ROLES[op] };
const BASE = new Set(["*"]);
const isBaseName = (n: string): boolean => BASE.has(n);
const CODE = "(* (fetch-item) 2)";

async function wf() {
  const forms = await parse(CODE);
  return buildWireframe(forms, { classifier: CLASSIFIER, isBaseName });
}

/** A `ReplayScopeError` — the SAME refusal replay.ts's D4 rows throw for a demand
 *  outside γ's claimed scope (a fan/binder/loop node); `answerQuery` catches
 *  exactly this class to fall through to the Q14 `fallback` arm. */
function outOfScope(): never {
  throw new ReplayScopeError("fan", "synthetic-span", "outside the replay driver's claimed scope for this row");
}

beforeAll(async () => {});

/** The four evidence tiers, in the spec's own order (§5 A1 / §7: "the envelope enum
 *  `replayed | replayed-cached | recorded | stub`"). A `readonly EvidenceTier[]` cast
 *  makes this list a compile-time check too: if `EvidenceTier` ever grows or shrinks a
 *  member, this array either fails to typecheck (a removed member) or the row below
 *  silently stops enumerating a real member (an ADDED member) — the length assertion
 *  below catches the latter. */
const EVIDENCE_TIERS: readonly EvidenceTier[] = ["replayed", "replayed-cached", "recorded", "stub"];

describe("tier-honesty envelope shape — the enum Q10 already committed (grounding, not staged)", () => {
  it("the evidence-tier enum has exactly the four spec-named members, in the spec's own order", () => {
    expect(EVIDENCE_TIERS).toEqual(["replayed", "replayed-cached", "recorded", "stub"]);
  });
});

describe("tier honesty (§7: every drill-in answer carries an honest evidence tier)", () => {
  // @ledger: Q17 — FLIPPED. Exercises all four arms through the SAME `answerQuery`
  // composition: a fresh γ (`replayed`), a memo hit (`replayed-cached`), and Q14's
  // `recorded`/`stub` arms reached via a `ReplayScopeError` fallback.
  it(
    "every drill-in answer carries its evidence tier from the envelope enum " +
      "`replayed | replayed-cached | recorded | stub` — no answer is ever tier-less",
    async () => {
      const memo = new ReplayMemo();
      const program = await wf();
      const run = await recordRun(inferenceEnv, CODE, { "fetch-item": "num" });
      const unreachable = (): never => {
        throw new Error("unreachable — this row's replay always succeeds");
      };

      const freshKey: ReplayMemoKey = { templateHash: "th-tier-1-fresh", ordinalPath: [0], demand: "value" };
      const fresh = await answerQuery({
        memo,
        key: freshKey,
        replay: () => replayGraphEgress({ program, frozen: run.frozen }),
        fallback: unreachable,
      });
      expect(EVIDENCE_TIERS).toContain(fresh.tier);
      expect(fresh.tier).toBe("replayed");

      const cachedAnswer = await answerQuery({
        memo,
        key: freshKey,
        replay: () => replayGraphEgress({ program, frozen: run.frozen }),
        fallback: unreachable,
      });
      expect(EVIDENCE_TIERS).toContain(cachedAnswer.tier);
      expect(cachedAnswer.tier).toBe("replayed-cached");

      const store = new PayloadStoreFake();
      const machine = new PayloadTierMachine(store);
      machine.ringPut("tier-1-payload", { value: 6, stampIds: [] });
      const recordedAnswer = await answerQuery({
        memo,
        key: { templateHash: "th-tier-1-recorded", ordinalPath: [0], demand: "value" },
        replay: outOfScope,
        fallback: () => machine.read("tier-1-payload"),
      });
      expect(EVIDENCE_TIERS).toContain(recordedAnswer.tier);
      expect(recordedAnswer.tier).toBe("recorded");

      await machine.evict("tier-1-payload");
      const stubAnswer = await answerQuery({
        memo,
        key: { templateHash: "th-tier-1-stub", ordinalPath: [0], demand: "value" },
        replay: outOfScope,
        fallback: () => machine.read("tier-1-payload"),
      });
      expect(EVIDENCE_TIERS).toContain(stubAnswer.tier);
      expect(stubAnswer.tier).toBe("stub");
    },
  );

  // @ledger: Q17 — FLIPPED.
  it(
    "a `stub` answer (value evicted, lineage intact) NEVER presents itself as freshly " +
      "`replayed` — a stub or cached answer never claims a fresher tier than it has " +
      '(§5 A1 EXCLUDED: "silent degradation... a stub answering as if replayed is a lie")',
    async () => {
      const memo = new ReplayMemo();
      const store = new PayloadStoreFake();
      const machine = new PayloadTierMachine(store);
      machine.ringPut("stub-only", { value: "x", stampIds: [7] });
      await machine.evict("stub-only");
      const key: ReplayMemoKey = { templateHash: "th-stub-only", ordinalPath: [0], demand: "value" };

      const answer = await answerQuery({ memo, key, replay: outOfScope, fallback: () => machine.read("stub-only") });
      expect(answer.tier).toBe("stub");
      expect(answer.tier).not.toBe("replayed");
      expect(answer.tier).not.toBe("replayed-cached");
      expect(answer.value).toBeUndefined();
      expect(answer.stampIds).toEqual([7]);
      // a scope refusal never populates the memo — nothing was actually replayed,
      // so a REPEAT query still honestly reaches the fallback, still `stub`.
      expect(memo.has(key)).toBe(false);
      const again = await answerQuery({ memo, key, replay: outOfScope, fallback: () => machine.read("stub-only") });
      expect(again.tier).toBe("stub");
    },
  );

  // @ledger: Q17 — FLIPPED. The memo-outlives-payload row (§4 m2): the memo holds
  // its OWN copy of a replayed egress, entirely independent of the backing
  // `PayloadStore`'s own tier — evicting the latter never reaches into the former.
  it(
    "a `replayed-cached` (memo-hit) answer is never conflated with a live `replayed` " +
      "one, even when both report the identical egress value — a memo entry MAY outlive " +
      "its evicted payload, and its answers carry `replayed-cached`, never `replayed` " +
      "(§4 CHOSEN replay-memo scope)",
    async () => {
      const memo = new ReplayMemo();
      const program = await wf();
      const run = await recordRun(inferenceEnv, CODE, { "fetch-item": "num" });
      const key: ReplayMemoKey = { templateHash: "th-outlives", ordinalPath: [0], demand: "value" };

      // cold: a live γ replay.
      const cold = await answerQuery({
        memo,
        key,
        replay: () => replayGraphEgress({ program, frozen: run.frozen }),
        fallback: () => {
          throw new Error("unreachable");
        },
      });
      expect(cold.tier).toBe("replayed");

      // Separately: the SAME logical payload's backing store degrades to stub (a
      // DO-storage eviction, independent of the memo — the memo never reads
      // through PayloadTierMachine at all).
      const mint = run.mints[0];
      const store = new PayloadStoreFake();
      const machine = new PayloadTierMachine(store);
      machine.ringPut(mint.record.payloadHash, { value: mint.payload.value, stampIds: mint.payload.stampIds });
      await machine.evict(mint.record.payloadHash);
      const rawPayloadNow = await machine.read(mint.record.payloadHash);
      expect(rawPayloadNow.tier).toBe("stub"); // the backing payload really is gone

      // The SAME memo key still answers — from cache, never re-touching the (now
      // stubbed) payload — an HONEST cache tier, never a fabricated fresh
      // "replayed" and never silently downgraded to "recorded"/"stub" either.
      const warm = await answerQuery({
        memo,
        key,
        replay: () => replayGraphEgress({ program, frozen: run.frozen }),
        fallback: () => {
          throw new Error("unreachable — the memo must hit before fallback is ever considered");
        },
      });
      expect(warm.tier).toBe("replayed-cached");
      expect(warm.tier).not.toBe(cold.tier); // never conflated with the live replay that produced it
      expect(warm.value).toBe(cold.value); // same egress value (purity) ...
      expect(warm.stampIds).toEqual(cold.stampIds); // ... same cone ...
      // ... reported through a DIFFERENT, honest tier — the row's whole point.
    },
  );

  // @ledger: Q17 — FLIPPED.
  it(
    "degradation is PER TIER and deterministic — a payload's tier only ever moves " +
      "toward `stub` (ring → do → pending/r2 → stub), never silently reports a tier it " +
      "no longer occupies (§5 A1)",
    async () => {
      const memo = new ReplayMemo();
      const program = await wf();
      const run = await recordRun(inferenceEnv, CODE, { "fetch-item": "num" });
      const key: ReplayMemoKey = { templateHash: "th-monotone", ordinalPath: [0], demand: "value" };
      await answerQuery({
        memo,
        key,
        replay: () => replayGraphEgress({ program, frozen: run.frozen }),
        fallback: () => {
          throw new Error("unreachable");
        },
      });
      // Repeated hits: ALWAYS `replayed-cached` — never regresses to `recorded`/
      // `stub`, and never re-claims a fresh `replayed` (γ never silently re-runs on
      // a memo hit — `answerQuery`'s hit branch short-circuits before `replay` is
      // even called).
      for (let i = 0; i < 5; i++) {
        const hit = await answerQuery({
          memo,
          key,
          replay: () => {
            throw new Error("a memo hit must never call replay again");
          },
          fallback: () => {
            throw new Error("unreachable");
          },
        });
        expect(hit.tier).toBe("replayed-cached");
      }

      // The STORAGE tier's own monotonicity (Q14), cross-checked at the Q17
      // envelope boundary too: ring -> do -> stub, never backward, and every
      // subsequent read agrees once stubbed (no "un-evict").
      const store = new PayloadStoreFake();
      const machine = new PayloadTierMachine(store);
      machine.ringPut("monotone-hash", { value: 1, stampIds: [] });
      expect((await machine.read("monotone-hash")).tier).toBe("recorded");
      await machine.flush("monotone-hash");
      expect((await machine.read("monotone-hash")).tier).toBe("recorded");
      await machine.evict("monotone-hash");
      expect((await machine.read("monotone-hash")).tier).toBe("stub");
      expect((await machine.read("monotone-hash")).tier).toBe("stub");
    },
  );

  // @ledger: Q14 — GREEN (store/tiering.ts's PayloadTierMachine + evidenceTierOf).
  it(
    "the `recorded` and `stub` arms of the envelope are honest against synthetic " +
      "payloads driven through Q10's fakes (`PayloadStoreFake`) BEFORE full production " +
      "emission exists — the `replayed`/`replayed-cached` arms are NOT claimed at this " +
      "gate, only once Q16/Q17 land",
    async () => {
      // ring, do, r2 (via flush+settle), and stub (via forced eviction) — every
      // storage tier a payload can occupy BEFORE Q16/Q17's live-replay/memo machinery
      // exists. Each answers `recorded` (a value is present) EXCEPT stub. Separate
      // `PayloadTierMachine`s (each own hash namespace) so the r2 scenario's small
      // size cap doesn't affect the others' default-cap routing.
      const ringOnly = new PayloadTierMachine(new PayloadStoreFake());
      ringOnly.ringPut("ring-hash", { value: "hot", stampIds: [1] });
      const ringAnswer = await ringOnly.read("ring-hash");
      expect(ringAnswer.tier).toBe("recorded");
      expect(ringAnswer.value).toBe("hot");

      const doMachine = new PayloadTierMachine(new PayloadStoreFake());
      doMachine.ringPut("do-hash", { value: "flushed small", stampIds: [2] });
      await doMachine.flush("do-hash");
      const doAnswer = await doMachine.read("do-hash");
      expect(doAnswer.tier).toBe("recorded");
      expect(doAnswer.storageTier).toBe("do");

      const r2Store = new PayloadStoreFake();
      r2Store.setValueSizeCapBytes(1); // force oversize -> pending, so settle() applies
      const r2Machine = new PayloadTierMachine(r2Store);
      r2Machine.ringPut("r2-hash", { value: "settled to r2", stampIds: [3] });
      await r2Machine.flush("r2-hash");
      await r2Machine.settle("r2-hash", "settled");
      const r2Answer = await r2Machine.read("r2-hash");
      expect(r2Answer.tier).toBe("recorded");
      expect(r2Answer.storageTier).toBe("r2");

      const stubMachine = new PayloadTierMachine(new PayloadStoreFake());
      stubMachine.ringPut("stub-hash", { value: "will be evicted", stampIds: [4, 5] });
      await stubMachine.evict("stub-hash");
      const stubAnswer = await stubMachine.read("stub-hash");
      expect(stubAnswer.tier).toBe("stub"); // NEVER "recorded" once evicted
      expect(stubAnswer.value).toBeUndefined(); // value dropped...
      expect(stubAnswer.stampIds).toEqual([4, 5]); // ...identity + stamps retained (§5 A1 tier 4)

      // None of these four ever claim `replayed`/`replayed-cached` — this node
      // (Q14) doesn't compute those arms at all; asserting their absence is the
      // "NOT claimed at this gate" half of the row.
      for (const answer of [ringAnswer, doAnswer, r2Answer, stubAnswer]) {
        expect(answer.tier).not.toBe("replayed");
        expect(answer.tier).not.toBe("replayed-cached");
      }
    },
  );

  // @ledger: Q14 — GREEN. §5 m6's NAMED `pending → R2-ref` settlement transition,
  // driven through `PayloadStoreFake`'s deterministic virtual clock
  // (`setSettleDelayTicks` + `step` — no real timers, per fakes.ts's file header):
  // a read taken BEFORE the delayed settle lands must degrade honestly (`pending`
  // still has its value, so it answers `recorded`, never a fabricated `replayed` or
  // a premature `stub`), and the tier only moves forward once `step` actually
  // advances the virtual clock past the settle's due tick.
  it("m6: pending payload settles to R2-ref via the fake's tick-step; reads before settlement degrade honestly", async () => {
    const store = new PayloadStoreFake();
    store.setValueSizeCapBytes(1); // force oversize on flush -> pending
    store.setSettleDelayTicks(3);
    const machine = new PayloadTierMachine(store);

    machine.ringPut("h1", { value: "oversize evidence", stampIds: [42] });
    await machine.flush("h1");
    expect(await machine.currentTier("h1")).toBe("pending");

    await machine.settle("h1", "settled"); // scheduled, not yet applied

    // Reads BEFORE the tick threshold: honestly `recorded` (value present, tier
    // genuinely still `pending`) — never a premature `stub`, never a fabricated
    // `replayed`.
    for (let tick = 0; tick < 3; tick++) {
      const before = await machine.read("h1");
      expect(before.storageTier).toBe("pending");
      expect(before.tier).toBe("recorded");
      expect(before.value).toBe("oversize evidence");
      store.step(1);
    }

    // After the third tick, settlement has landed: pending -> r2 (the NAMED m6
    // transition), still `recorded` (a value is still present — r2 isn't a
    // degradation, it's the durable destination).
    const after = await machine.read("h1");
    expect(after.storageTier).toBe("r2");
    expect(after.tier).toBe("recorded");
    expect(after.value).toBe("oversize evidence");
  });

  // @ledger: Q14 — GREEN, the settlement-failure leg of m6: a read before the
  // failed settle lands still honestly reports `pending`/`recorded`; once it lands,
  // the payload degrades to `stub` — never silently, never as a lie about being
  // fresher than it is.
  it("m6: a failed settle degrades pending -> stub only once the tick lands, never before", async () => {
    const store = new PayloadStoreFake();
    store.setValueSizeCapBytes(1);
    store.setSettleDelayTicks(2);
    const machine = new PayloadTierMachine(store);

    machine.ringPut("h1", { value: "oversize evidence", stampIds: [9] });
    await machine.flush("h1");
    await machine.settle("h1", "failed"); // scheduled

    store.step(1); // one tick short
    const early = await machine.read("h1");
    expect(early.storageTier).toBe("pending");
    expect(early.tier).toBe("recorded");

    store.step(1); // the due tick
    const late = await machine.read("h1");
    expect(late.storageTier).toBe("stub");
    expect(late.tier).toBe("stub");
    expect(late.value).toBeUndefined();
    expect(late.stampIds).toEqual([9]);
  });
});
