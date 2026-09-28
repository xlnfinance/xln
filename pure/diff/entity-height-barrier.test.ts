// og's entity-height durability barrier (core/runtime/mempool/entity-height-barrier.ts
// applyEntityHeightDurabilityBarrier) against the rewrite's entityHeightBarrier, on random Runtime input queues: the
// same inputs are selected for the frame and the same ones are requeued, in the same order.
import { describe, expect, test } from "bun:test";
import { applyEntityHeightDurabilityBarrier } from "../../core/runtime/mempool/entity-height-barrier.ts";
import { entityHeightBarrier, type EntityReplica, type RoutedEntityInput, type RuntimeTx } from "../xln.ts";
import { lcg31, seedOf, seedTag, untilCovered } from "./seed.ts";

let seed = seedOf(0xba77e);
const rng = (): number => {
  seed = lcg31(seed);
  return seed / 0x7fffffff;
};
const ri = (n: number): number => Math.floor(rng() * n);
const pick = <T>(xs: readonly T[]): T => xs[ri(xs.length)] as T;

const ENTITIES = [1, 2, 3].map((n) => `0x${n.toString(16).padStart(64, "0")}`);
const SIGNERS = ["0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc"];
const RUNTIMES = ["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", "0x90f79bf6eb2c4f870365e785982e1f101e93b906"];
/**
 * A signer as some sender spells it. Only case varies: og entityInputMergeKey lowercases the signer without trimming
 * while the rewrite's mergeKey also trims, so a padded signer id splits merge groups differently (reported, not part
 * of this barrier).
 */
const spelled = (s: string): string => pick([s, s.toUpperCase().replace("0X", "0x")]);

/** One drawn input, built on both sides from the same description. */
type Drawn = { readonly og: Record<string, unknown>; readonly rw: RoutedEntityInput };
type Lane = { readonly entityId: string; readonly signerId: string };
const envelope = (lane: Lane): { readonly og: Record<string, unknown>; readonly rw: Record<string, unknown> } => {
  const from = pick([undefined, undefined, ...RUNTIMES]);
  const cross = ri(5) === 0;
  const sourceRuntimeFrame = cross || ri(3) === 0 ? { height: 1 + ri(3), timestamp: 1_700_000_000_000 + ri(2) } : undefined;
  const marker = cross ? { phase: pick(["proposal", "ack"] as const), pairKey: pick(["p1", "p2"]) } : undefined;
  const fields = {
    entityId: lane.entityId,
    signerId: spelled(lane.signerId),
    ...(from === undefined ? {} : { from }),
    ...(sourceRuntimeFrame === undefined ? {} : { sourceRuntimeFrame }),
    ...(marker === undefined ? {} : { atomicCrossJurisdictionPair: marker }),
  };
  return { og: fields, rw: fields };
};
const WAKES = [
  { type: "scheduledWake", data: { dueAt: 1, jobs: ["a"] } },
  { type: "scheduledWake", data: { dueAt: 2, jobs: ["b"] } },
];
const drawInput = (lanes: readonly Lane[], heights: ReadonlyMap<string, number>): Drawn => {
  const lane = pick(lanes);
  const at = heights.get(`${lane.entityId}:${lane.signerId}`) ?? 0;
  const height = pick([0, at, at + 1, at + 1, at + 1, at + 2]);
  const frameHash = pick(["0xaa", "0xbb"]);
  const env = envelope(lane);
  switch (ri(5)) {
    case 0:
      return {
        og: { ...env.og, proposedFrame: { height, hash: frameHash, timestamp: 1 } },
        rw: {
          ...env.rw,
          input: { kind: "proposal", frame: { height: BigInt(height), timestamp: 1n }, signatures: new Map() },
        } as unknown as RoutedEntityInput,
      };
    case 1: {
      const signatures = new Map([[pick(SIGNERS), ["0x01"]]]);
      return {
        og: { ...env.og, hashPrecommitFrame: { height, frameHash }, hashPrecommits: signatures },
        rw: {
          ...env.rw,
          input: { kind: "precommit", height: BigInt(height), frameHash, signatures },
        } as unknown as RoutedEntityInput,
      };
    }
    default: {
      const wake = ri(3) === 0 ? [pick(WAKES)] : [];
      const plain = Array.from({ length: ri(3) }, () => ({ type: "chatMessage", data: { message: pick(["x", "y"]) } }));
      const txs = [...wake, ...plain];
      return {
        og: { ...env.og, entityTxs: txs },
        rw: { ...env.rw, input: { kind: "txs", timestamp: 1n, txs } } as unknown as RoutedEntityInput,
      };
    }
  }
};

type Case = {
  readonly replicas: readonly { readonly lane: Lane; readonly height: number }[];
  readonly imports: readonly Lane[];
  readonly inputs: readonly Drawn[];
};
const drawCase = (): Case => {
  const lanes = ENTITIES.flatMap((entityId) => SIGNERS.map((signerId) => ({ entityId, signerId })));
  const replicas = lanes.filter(() => ri(3) > 0).map((lane) => ({ lane, height: ri(4) }));
  const imports = lanes.filter((l) => !replicas.some((r) => r.lane === l) && ri(2) === 0);
  const heights = new Map(replicas.map((r) => [`${r.lane.entityId}:${r.lane.signerId}`, r.height]));
  const busy = Array.from({ length: 1 + ri(3) }, () => pick(lanes));
  const inputs = Array.from({ length: 1 + ri(10) }, () => drawInput(busy, heights));
  return { replicas, imports, inputs };
};
const importTx = (lane: Lane): RuntimeTx =>
  ({ type: "importReplica", entityId: lane.entityId, signerId: spelled(lane.signerId), data: {} }) as unknown as RuntimeTx;

type Split = { readonly selected: readonly number[]; readonly deferred: readonly number[] };
const ogSplit = (c: Case): Split | string => {
  const eReplicas = new Map(
    c.replicas.map((r) => [
      `${r.lane.entityId}:${r.lane.signerId}`,
      { entityId: r.lane.entityId, signerId: r.lane.signerId, state: { entityId: r.lane.entityId, height: r.height } },
    ]),
  );
  const env = { state: { eReplicas } };
  const originals = c.inputs.map((d) => d.og);
  const sentinel = { entityId: ENTITIES[0], signerId: SIGNERS[0], entityTxs: [] };
  const input = { runtimeTxs: c.imports.map(importTx), entityInputs: [...originals] };
  const mempool = { runtimeTxs: [], entityInputs: [sentinel] };
  try {
    applyEntityHeightDurabilityBarrier(env as never, input as never, mempool as never, 1);
  } catch (e) {
    return String((e as Error).message);
  }
  const queued = mempool.entityInputs as unknown[];
  expect(queued.at(-1)).toBe(sentinel);
  return {
    selected: input.entityInputs.map((i) => originals.indexOf(i)),
    deferred: queued.slice(0, -1).map((i) => originals.indexOf(i as Record<string, unknown>)),
  };
};
const rwSplit = (c: Case): Split | string => {
  const entities = new Map(
    c.replicas.map((r) => [
      `${r.lane.entityId}:${r.lane.signerId}`,
      { signerId: r.lane.signerId, state: { id: r.lane.entityId, height: BigInt(r.height) } } as unknown as EntityReplica,
    ]),
  );
  const inputs = c.inputs.map((d) => d.rw);
  const out = entityHeightBarrier(entities, c.imports.map(importTx), inputs);
  if (!out.ok) return String((out.error as { code?: string }).code);
  return {
    selected: out.value.selected.map((i) => inputs.indexOf(i)),
    deferred: out.value.deferred.map((i) => inputs.indexOf(i)),
  };
};

describe(seedTag("entity-height barrier (og runtime/mempool/entity-height-barrier.ts)"), () => {
  test("MATCH (randomized): the same inputs are applied and the same ones requeued, in order", () => {
    const seen = { deferred: 0, cohort: 0, passed: 0 };
    const covered = (): boolean => seen.deferred > 50 && seen.cohort > 5 && seen.passed > 50;
    for (let i = 0, more = untilCovered(1500, covered); more(i); i++) {
      const c = drawCase();
      const og = ogSplit(c);
      const rw = rwSplit(c);
      expect(rw).toEqual(og);
      if (typeof og === "string") continue;
      if (og.deferred.length > 0) seen.deferred += 1;
      else seen.passed += 1;
      const deferredLeg = og.deferred.some((k) => c.inputs[k]?.og["atomicCrossJurisdictionPair"] !== undefined);
      if (deferredLeg) seen.cohort += 1;
    }
    expect(covered()).toBe(true);
  });
});
