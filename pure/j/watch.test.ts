import { describe, expect, test } from "bun:test";
import { err, unwrapOr, type Result } from "../kernel/core/result.ts";
import { draw } from "../account/fixtures.ts";
import { decodeLogs, type Bytes32, type ChainEvent, type RawLog } from "./log.ts";
import { beginsAt, readingKey, type Accounts, type Addressed, type Reading } from "./observe.ts";
import {
  advance, finalizedAt, prepare, readings, splitStalled, watching, type Batch, type Block, type Step, type Watch,
  type WatchFault, type Window,
} from "./watch.ts";
import {
  blockOf, blocksBetween, bodyHashOf, DEPLOYED, DEPOSITORY, entityOf, hashOf, hexOf, logOf, must, txOf,
} from "./fixtures.ts";

const LEFT = entityOf(0x11n);
const RIGHT = entityOf(0x52n);
const BYSTANDER = entityOf(0x99n);
/** The proof the started dispute of `started` opened with: its author and body hash. */
const OPENED = { proposerIsLeft: true, bodyHash: bodyHashOf(1n) } as const;

const GENESIS = blockOf(0n);

const start = (depth: bigint, from: Block = GENESIS): Watch => must(watching(DEPLOYED, depth, from));

const advanced = (block: bigint, index: bigint, epoch: bigint, fork = 0n) =>
  logOf("AccountEpochAdvanced", { left: LEFT, right: RIGHT, ondeltaEpoch: epoch }, block, index, fork);

const started = (block: bigint, index: bigint, fork = 0n) =>
  logOf("DisputeStarted", {
    sender: RIGHT, counterentity: LEFT, nonce: 7n, proposerIsLeft: true, proofbodyHash: hexOf(1n), watchSeed: hexOf(2n),
    starterInitialArguments: "0x", starterCounterArguments: "0x", starterCounterProofCommitment: hexOf(3n),
    disputeTimeout: 500n, disputeStartTimestamp: 6n, leftResponseSeconds: 60n, rightResponseSeconds: 60n,
  }, block, index, fork);

const finalized = (block: bigint, index: bigint, fork = 0n) =>
  logOf("DisputeFinalized", {
    sender: RIGHT, counterentity: LEFT, nonce: 7n, finalProofbodyHash: hexOf(5n), finalizationEvidenceHash: hexOf(6n),
  }, block, index, fork);

/** What the chain stores for the Account at the end of each block asked about, as a node would answer. */
const answered = (stored: (block: bigint) => { epoch: bigint; nonce: bigint }) =>
  (asked: readonly Reading[]): Accounts => new Map(asked.map((r) => [readingKey(r), stored(r.block)] as const));

/** Prepare, ask the chain, and deliver one batch, as the Host does. */
const deliver = (
  w: Watch, batch: Batch, hosted: readonly typeof LEFT[], stored: (block: bigint) => { epoch: bigint; nonce: bigint },
  windows: readonly Window[] = [],
): Result<Step, WatchFault> => {
  const prepared = prepare(w, batch);
  const asked = prepared.ok ? readings(prepared.value, hosted) : [];
  return prepared.ok ? advance(w, prepared.value, hosted, answered(stored)(asked), windows) : prepared;
};

const toward = (to: typeof LEFT, event: Addressed["event"]): Addressed => ({ to, event });

describe("j/watch", () => {
  const lifecycleChain = (block: bigint) => {
    switch (true) {
      case block >= 4n: return { epoch: 2n, nonce: 8n };
      case block === 3n: return { epoch: 1n, nonce: 7n };
      default: return { epoch: 1n, nonce: 5n };
    }
  };
  const lifecycle: Batch = {
    head: 6n,
    blocks: blocksBetween(0n, 4n),
    logs: [advanced(2n, 0n, 1n), started(3n, 0n), finalized(4n, 0n), advanced(4n, 1n, 2n)],
  };

  test("R-WATCH-ORDER one delivery is the chain's events for each hosted Entity in order, to its last block", () => {
    const step = must(deliver(start(2n), lifecycle, [LEFT, RIGHT, BYSTANDER], lifecycleChain));
    expect(step.events).toEqual([
      toward(LEFT, { _tag: "j_epoch", peer: RIGHT, epoch: 1n, stored: 5n }),
      toward(RIGHT, { _tag: "j_epoch", peer: LEFT, epoch: 1n, stored: 5n }),
      toward(LEFT, { _tag: "j_dispute", peer: RIGHT, epoch: 1n, by: "right", nonce: 7n, timeout: 500n, ...OPENED }),
      toward(RIGHT, { _tag: "j_dispute", peer: LEFT, epoch: 1n, by: "right", nonce: 7n, timeout: 500n, ...OPENED }),
      toward(LEFT, { _tag: "j_dispute_over", peer: RIGHT }),
      toward(RIGHT, { _tag: "j_dispute_over", peer: LEFT }),
      toward(LEFT, { _tag: "j_epoch", peer: RIGHT, epoch: 2n, stored: 8n }),
      toward(RIGHT, { _tag: "j_epoch", peer: LEFT, epoch: 2n, stored: 8n }),
    ]);
    expect(step.watch.applied).toEqual(blockOf(4n));
    expect(step.height).toBe(4n as typeof step.height);
  });

  test("R-DISPUTE-FINALIZE a window the last block has passed is told after the logs, and not before", () => {
    const window = (to: typeof LEFT, peer: typeof LEFT, timeout: bigint): Window => ({ to, peer, timeout });
    const told = (windows: readonly Window[], hosted = [LEFT]) =>
      must(deliver(start(2n), lifecycle, hosted, lifecycleChain, windows)).events
        .filter((e) => e.event._tag === "j_window_over");
    const over = (to: typeof LEFT, peer: typeof LEFT): Addressed => toward(to, { _tag: "j_window_over", peer });
    expect(blockOf(4n).timestamp).toBe(40n);
    expect(told([window(LEFT, RIGHT, 40n)])).toEqual([over(LEFT, RIGHT)]);
    expect(told([window(LEFT, RIGHT, 41n)])).toEqual([]);
    expect(told([window(LEFT, RIGHT, 5n), window(LEFT, BYSTANDER, 40n), window(LEFT, RIGHT, 90n)]))
      .toEqual([over(LEFT, RIGHT), over(LEFT, BYSTANDER)]);
    expect(told([window(RIGHT, LEFT, 40n)])).toEqual([]);
    const step = must(deliver(start(2n), lifecycle, [LEFT], lifecycleChain, [window(LEFT, RIGHT, 40n)]));
    expect(step.events.at(-1)).toEqual(over(LEFT, RIGHT));
  });

  test("R-DISPUTE-FINALIZE a window the delivery itself opened for the node's own start is told after it", () => {
    const by = (sender: typeof LEFT, counterentity: typeof LEFT, timeout: bigint) => logOf("DisputeStarted", {
      sender, counterentity, nonce: 7n, proposerIsLeft: true, proofbodyHash: hexOf(1n), watchSeed: hexOf(2n),
      starterInitialArguments: "0x", starterCounterArguments: "0x", starterCounterProofCommitment: hexOf(3n),
      disputeTimeout: timeout, disputeStartTimestamp: 6n, leftResponseSeconds: 60n, rightResponseSeconds: 60n,
    }, 3n, 0n, 0n);
    const told = (log: RawLog) =>
      must(deliver(start(2n), { head: 6n, blocks: blocksBetween(0n, 4n), logs: [log] }, [LEFT], lifecycleChain)).events
        .map((e) => e.event._tag);
    expect(told(by(LEFT, RIGHT, 40n))).toEqual(["j_dispute", "j_window_over"]);
    expect(told(by(LEFT, RIGHT, 41n))).toEqual(["j_dispute"]);
    expect(told(by(RIGHT, LEFT, 40n))).toEqual(["j_dispute"]);
  });

  test("R-WATCH-ORDER an Entity that is not hosted is told nothing, and the delivery still moves the cursor", () => {
    const step = must(deliver(start(2n), lifecycle, [BYSTANDER], lifecycleChain));
    expect(step.events).toEqual([]);
    expect(step.watch.applied).toEqual(blockOf(4n));
  });

  test("R-WATCH-DEPTH a block is delivered once the head is depth above it, and not before", () => {
    const w = start(2n);
    const batch = (head: bigint): Batch => ({ head, blocks: blocksBetween(0n, 4n), logs: [] });
    expect(finalizedAt(2n, 6n)).toBe(4n);
    expect(deliver(w, batch(6n), [LEFT], lifecycleChain).ok).toBe(true);
    const early = (finalized: bigint) => err({ _tag: "beyond_depth" as const, block: 4n, finalized });
    expect(deliver(w, batch(5n), [LEFT], lifecycleChain)).toEqual(early(3n));
    expect(deliver(w, batch(4n), [LEFT], lifecycleChain)).toEqual(early(2n));
  });

  test("R-WATCH-DEPTH a chain younger than its depth has nothing final: only a batch with no blocks is allowed", () => {
    const w = start(12n);
    expect(finalizedAt(12n, 5n)).toBe(0n);
    expect(deliver(w, { head: 5n, blocks: [], logs: [] }, [LEFT], lifecycleChain).ok).toBe(true);
    expect(deliver(w, { head: 5n, blocks: blocksBetween(0n, 1n), logs: [] }, [LEFT], lifecycleChain).ok).toBe(false);
  });

  test("R-WATCH-DEPTH an empty batch is the cursor again: it announces the height it has and moves nothing", () => {
    const w = start(2n, blockOf(9n));
    const step = must(deliver(w, { head: 20n, blocks: [], logs: [] }, [LEFT], lifecycleChain));
    expect(step.watch).toEqual(w);
    expect(step.events).toEqual([]);
    expect(step.height).toBe(9n as typeof step.height);
  });

  test("R-WATCH-DEPTH a depth below zero is refused when the watch starts", () => {
    expect(watching(DEPLOYED, -1n, GENESIS)).toEqual(err({ _tag: "bad_depth", depth: -1n }));
    expect(watching(DEPLOYED, 0n, GENESIS).ok).toBe(true);
  });

  test("R-WATCH-DEPTH a first block whose parent is not the cursor's block is a reorg deeper than the depth", () => {
    const w = start(2n);
    const forked: Batch = { head: 9n, blocks: blocksBetween(0n, 3n, 1n), logs: [] };
    expect(prepare(w, forked)).toEqual(err({ _tag: "deep_reorg", at: 1n, applied: hashOf(0n), chain: hashOf(0n, 1n) }));
  });

  test("R-WATCH-ORDER a block that does not follow the one before it is a broken chain, a missing one is a gap", () => {
    const w = start(2n);
    const [one, two, three] = blocksBetween(0n, 3n);
    const [, otherTwo] = blocksBetween(0n, 2n, 1n);
    const crooked = { ...(otherTwo as Block), parent: hashOf(1n, 1n) };
    const broken: Batch = { head: 9n, blocks: [one as Block, crooked], logs: [] };
    expect(prepare(w, broken)).toEqual(err({ _tag: "broken_chain", at: 2n }));
    const gapped: Batch = { head: 9n, blocks: [one as Block, three as Block], logs: [] };
    expect(prepare(w, gapped)).toEqual(err({ _tag: "gap", expected: 2n, found: 3n }));
    const skipped: Batch = { head: 9n, blocks: [two as Block], logs: [] };
    expect(prepare(w, skipped)).toEqual(err({ _tag: "gap", expected: 1n, found: 2n }));
  });

  test("R-WATCH-ORDER a log of a block the batch does not hold, or of another fork's block, is refused", () => {
    const w = start(2n);
    const blocks = blocksBetween(0n, 3n);
    const missing = prepare(w, { head: 9n, blocks, logs: [advanced(5n, 0n, 1n)] });
    expect(missing).toEqual(err({ _tag: "log_without_block", block: 5n, index: 0n }));
    const otherFork = prepare(w, { head: 9n, blocks, logs: [advanced(2n, 0n, 1n, 1n)] });
    expect(otherFork).toEqual(err({ _tag: "log_without_block", block: 2n, index: 0n }));
  });

  test("R-WATCH-ORDER logs that run backwards or repeat are refused, not sorted or deduplicated", () => {
    const w = start(2n);
    const blocks = blocksBetween(0n, 3n);
    const run = (logs: readonly RawLog[]) => prepare(w, { head: 9n, blocks, logs });
    const backwards = err({ _tag: "log_out_of_order" as const, block: 2n, index: 0n });
    expect(run([advanced(3n, 0n, 1n), advanced(2n, 0n, 1n)])).toEqual(backwards);
    expect(run([advanced(2n, 1n, 1n), advanced(2n, 0n, 1n)])).toEqual(backwards);
    expect(run([advanced(2n, 0n, 1n), advanced(2n, 0n, 1n)])).toEqual(backwards);
  });

  test("R-WATCH-CLOSED an event the watcher does not know is a fault of the whole delivery and moves no cursor", () => {
    const w = start(2n);
    const odd: RawLog = { ...advanced(2n, 0n, 1n), topics: [entityOf(0xdeadn)] };
    const batch: Batch = { head: 9n, blocks: blocksBetween(0n, 3n), logs: [advanced(1n, 0n, 1n), odd] };
    const refused = deliver(w, batch, [LEFT], lifecycleChain);
    expect(refused.ok).toBe(false);
    expect(refused.ok || refused.error._tag).toBe("unknown_event");
  });

  test("a chain that disagrees with the log about an epoch is a fault, not an event with a guessed epoch", () => {
    const wrong = (block: bigint) => ({ epoch: block >= 4n ? 5n : 1n, nonce: 1n });
    const refused = deliver(start(2n), lifecycle, [LEFT], wrong);
    expect(refused.ok).toBe(false);
    expect(refused.ok || refused.error._tag).toBe("reading_off");
  });

  test("a fault leaves the watch as it was: the next try starts from the same cursor", () => {
    const w = start(2n);
    deliver(w, { head: 5n, blocks: blocksBetween(0n, 4n), logs: [] }, [LEFT], lifecycleChain);
    expect(w).toEqual(start(2n));
    expect(deliver(w, lifecycle, [LEFT], lifecycleChain)).toEqual(deliver(w, lifecycle, [LEFT], lifecycleChain));
  });

  // The oracle: events read straight off a plan of what each block did, not through the decoder or the observer.
  type Did = "advance" | "dispute" | "finalize";
  const KINDS: readonly Did[] = ["advance", "dispute", "finalize"];
  const planOf = (seed: number, run: number, blocks: number): readonly (readonly Did[])[] =>
    Array.from({ length: blocks }, (_, b) =>
      Array.from({ length: draw(seed, run, b, 0, 3) }, (_, i) => KINDS[draw(seed, run, b, i + 1, 3)] as Did));

  const epochBefore = (plan: readonly (readonly Did[])[], block: number, index: number): bigint =>
    BigInt(plan.slice(0, block).flat().filter((d) => d === "advance").length
      + (plan[block] ?? []).slice(0, index).filter((d) => d === "advance").length);

  type Plan = readonly (readonly Did[])[];

  const logOfDid = (plan: Plan, b: number, i: number): RawLog => {
    const [block, index] = [BigInt(b + 1), BigInt(i)];
    switch (plan[b]?.[i]) {
      case "advance": return advanced(block, index, epochBefore(plan, b, i) + 1n);
      case "dispute": return started(block, index);
      default: return finalized(block, index);
    }
  };

  const logsOf = (plan: Plan): readonly RawLog[] =>
    plan.flatMap((dids, b) => dids.map((_, i) => logOfDid(plan, b, i)));

  const bothHear = (event: (peer: typeof LEFT) => Addressed["event"]): readonly Addressed[] =>
    [toward(LEFT, event(RIGHT)), toward(RIGHT, event(LEFT))];

  /** The finalize that follows an advance in its block, with no other advance between, makes it a finalize's own. */
  const finalBodyOf = (plan: Plan, b: number, i: number) =>
    ((plan[b] ?? []).slice(i + 1).find((d) => d !== "dispute") === "finalize" ? { finalBodyHash: bodyHashOf(5n) } : {});

  const toldOf = (plan: Plan, b: number, i: number): readonly Addressed[] => {
    const [nonce, epoch] = [BigInt(b + 1) * 3n, epochBefore(plan, b, i)];
    switch (plan[b]?.[i]) {
      case "advance":
        return bothHear((peer) =>
          ({ _tag: "j_epoch", peer, epoch: epoch + 1n, stored: nonce, ...finalBodyOf(plan, b, i) }));
      case "dispute":
        return bothHear((peer) =>
          ({ _tag: "j_dispute", peer, epoch, by: "right", nonce: 7n, timeout: 500n, ...OPENED }));
      default: return bothHear((peer) => ({ _tag: "j_dispute_over", peer }));
    }
  };

  const oracle = (plan: Plan): readonly Addressed[] =>
    plan.flatMap((dids, b) => dids.flatMap((_, i) => toldOf(plan, b, i)));

  const chainOf = (plan: readonly (readonly Did[])[]) => (block: bigint) =>
    ({ epoch: BigInt(plan.slice(0, Number(block)).flat().filter((d) => d === "advance").length), nonce: block * 3n });

  const cuts = (seed: number, run: number, blocks: number): readonly number[] =>
    Array.from({ length: blocks }, (_, i) => i + 1).filter((at, i) => at === blocks || draw(seed, run, i, 99, 3) === 0);

  type Delivered = Readonly<{ w: Watch; events: readonly Addressed[]; heights: readonly bigint[] }>;

  const BLOCKS = 14;
  const SEEDS = [1, 12345, 987654];

  test("R-WATCH-ORDER however the blocks are cut into batches, the events are the chain's, once each, in order", () => {
    const hosted = [LEFT, RIGHT] as const;
    SEEDS.forEach((seed) => Array.from({ length: 12 }, (_, run) => run).forEach((run) => {
      const plan = planOf(seed, run, BLOCKS);
      const all = logsOf(plan);
      const blocks = blocksBetween(0n, BigInt(BLOCKS));
      const chunks = cuts(seed, run, BLOCKS).map((to, i, ends) => [i === 0 ? 0 : (ends[i - 1] as number), to] as const);
      const done = chunks.reduce<Delivered>((acc, [from, to]) => {
        const batch: Batch = {
          head: BigInt(BLOCKS) + 2n, blocks: blocks.slice(from, to),
          logs: all.filter((l) => l.block > BigInt(from) && l.block <= BigInt(to)),
        };
        const step = must(deliver(acc.w, batch, hosted, chainOf(plan)));
        return { w: step.watch, events: [...acc.events, ...step.events], heights: [...acc.heights, step.height] };
      }, { w: start(2n), events: [], heights: [] });
      expect(done.events).toEqual(oracle(plan));
      expect(done.w.applied).toEqual(blockOf(BigInt(BLOCKS)));
      expect(done.heights).toEqual(chunks.map(([, to]) => BigInt(to)));
    }));
  });

  test("R-WATCH-ORDER a delivery repeated from the old cursor, as after a crash, is the same delivery", () => {
    const plan = planOf(1, 3, BLOCKS);
    const batch: Batch = { head: 99n, blocks: blocksBetween(0n, BigInt(BLOCKS)), logs: logsOf(plan) };
    const first = deliver(start(2n), batch, [LEFT, RIGHT], chainOf(plan));
    expect(first.ok).toBe(true);
    expect(deliver(start(2n), batch, [LEFT, RIGHT], chainOf(plan))).toEqual(first);
    expect(unwrapOr(first, () => expect.unreachable("delivered")).events).toEqual(oracle(plan));
  });
});

describe("j/watch what a transaction the Host cannot read holds back (R-WATCH-STALL)", () => {
  const eventsOf = (logs: readonly RawLog[]): readonly ChainEvent[] => must(decodeLogs(DEPLOYED, logs));
  const secret = (block: bigint, n: bigint) =>
    logOf("SecretRevealed", { hashlock: hexOf(n), revealer: RIGHT, secret: hexOf(n + 1n) }, block, 0n);
  const other = (block: bigint, index: bigint, epoch: bigint) =>
    logOf("AccountEpochAdvanced", { left: LEFT, right: BYSTANDER, ondeltaEpoch: epoch }, block, index);
  const places = (events: readonly ChainEvent[]) => events.map((e) => `${e._tag}@${e.block}.${e.index}`);
  const logs = [
    secret(1n, 7n), advanced(2n, 0n, 1n), advanced(3n, 0n, 2n), finalized(3n, 1n), advanced(4n, 0n, 3n),
    other(4n, 1n, 1n), secret(4n, 9n),
  ];

  test("R-WATCH-STALL a finalize the Host cannot read holds its Account from the advance it made, no other", () => {
    const events = eventsOf(logs);
    const split = splitStalled(events, new Set([txOf(3n, 1n)]));
    expect(places(split.ready)).toEqual([
      "secret_revealed@1.0", "epoch_advanced@2.0", "epoch_advanced@4.1", "secret_revealed@4.0",
    ]);
    expect(places(split.held)).toEqual(["epoch_advanced@3.0", "dispute_finalized@3.1", "epoch_advanced@4.0"]);
  });

  test("R-WATCH-STALL a start the Host cannot read holds its Account from the start; earlier events go on", () => {
    const events = eventsOf([advanced(2n, 0n, 1n), started(3n, 0n), advanced(4n, 0n, 2n), other(4n, 1n, 1n)]);
    const split = splitStalled(events, new Set([txOf(3n, 0n)]));
    expect(places(split.ready)).toEqual(["epoch_advanced@2.0", "epoch_advanced@4.1"]);
    expect(places(split.held)).toEqual(["dispute_started@3.0", "epoch_advanced@4.0"]);
  });

  test("R-WATCH-STALL with nothing stalled everything is told; a tx no event names holds nothing", () => {
    const events = eventsOf(logs);
    expect(splitStalled(events, new Set())).toEqual({ ready: events, held: [] });
    expect(splitStalled(events, new Set([txOf(9n, 9n) as Bytes32])).held).toEqual([]);
  });

  test("R-WATCH-STALL a finalize begins at the advance it made; an earlier advance is not its own", () => {
    const events = eventsOf(logs);
    const final = events.find((e) => e._tag === "dispute_finalized") ?? expect.unreachable("no finalize");
    expect(beginsAt(events, final)).toMatchObject({ block: 3n, index: 0n });
    const alone = eventsOf([finalized(3n, 1n)]);
    expect(beginsAt(alone, alone[0] ?? expect.unreachable("none"))).toMatchObject({ block: 3n, index: 1n });
  });
});
