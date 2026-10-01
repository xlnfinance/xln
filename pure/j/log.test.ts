import { describe, expect, test } from "bun:test";
import { EventFragment } from "ethers";
import { err, ok } from "../kernel/core/result.ts";
import { none } from "../kernel/core/option.ts";
import {
  bytes32, address, decodeLog, decodeLogs, IGNORED, READ_SIGNATURES, topicOf, type ChainEvent, type RawLog,
} from "./log.ts";
import { DEPOSITORY, DEPOSITORY_ABI, entityOf, hexOf, lifecyclePhases, logOf, must } from "./fixtures.ts";

const LEFT = entityOf(0x11n);
const RIGHT = entityOf(0x52n);

const FRAGMENTS = DEPOSITORY_ABI.fragments.flatMap((f) => (EventFragment.isFragment(f) ? [f] : []));

const disputeArgs = { sender: RIGHT, counterentity: LEFT, nonce: 7n };

describe("j/log", () => {
  test("R-WATCH-CLOSED every event of the deployed Depository is read or named as ignored, and none is both", () => {
    const abi = FRAGMENTS.map((fragment) => fragment.format("sighash")).toSorted();
    const listed = [...READ_SIGNATURES, ...IGNORED].toSorted();
    expect(listed).toEqual(abi);
    expect(READ_SIGNATURES.filter((signature) => IGNORED.includes(signature))).toEqual([]);
  });

  test("R-WATCH-CLOSED the topic 0 of each listed signature is the one the ABI computes", () => {
    FRAGMENTS.forEach((fragment) => expect(topicOf(fragment.format("sighash"))).toBe(fragment.topicHash));
  });

  test("R-WATCH-CLOSED every log of the real lifecycle decodes: the four events are read, the rest are ignored", () => {
    const read = new Set(["AccountEpochAdvanced", "DisputeStarted", "CounterDisputeRegistered", "DisputeFinalized"]);
    const phases = Object.values(lifecyclePhases);
    const logged = (e: (typeof phases)[number]["events"][number], p: number) =>
      ({ e, log: logOf(e.name, e.args, BigInt(p + 1), BigInt(e.logIndex)) });
    const seen = phases.flatMap((phase, p) => phase.events.map((e) => logged(e, p)));
    expect(seen.length).toBeGreaterThan(10);
    seen.forEach(({ e, log }) => {
      const decoded = decodeLog(DEPOSITORY, log);
      expect(decoded.ok).toBe(true);
      expect(decoded.ok && decoded.value._tag === "some").toBe(read.has(e.name));
    });
    expect(seen.filter(({ e }) => read.has(e.name)).length).toBeGreaterThanOrEqual(3);
  });

  test("an epoch advance reads its two entities from the topics and its epoch from the data", () => {
    const log = logOf("AccountEpochAdvanced", { left: LEFT, right: RIGHT, ondeltaEpoch: 9n }, 4n, 2n);
    expect(decodeLog(DEPOSITORY, log)).toEqual(ok({
      _tag: "some", value: { _tag: "epoch_advanced", block: 4n, index: 2n, left: LEFT, right: RIGHT, epoch: 9n },
    }));
  });

  test("a dispute start, a counter and a finalize read sender, counterentity and nonce from the topics", () => {
    const started = logOf("DisputeStarted", {
      ...disputeArgs, proposerIsLeft: true, proofbodyHash: hexOf(1n), watchSeed: hexOf(2n),
      starterInitialArguments: "0x", starterCounterArguments: "0x", starterCounterProofCommitment: hexOf(3n),
      disputeTimeout: 5n, disputeStartTimestamp: 6n,
      leftResponseSeconds: 60n, rightResponseSeconds: 60n,
    }, 3n, 0n);
    const countered = logOf("CounterDisputeRegistered", {
      ...disputeArgs, proposerIsLeft: false, proofbodyHash: hexOf(4n),
    }, 3n, 1n);
    const finalized = logOf("DisputeFinalized", {
      ...disputeArgs, finalProofbodyHash: hexOf(5n), finalizationEvidenceHash: hexOf(6n),
    }, 3n, 2n);
    const fact = { sender: RIGHT, counter: LEFT, nonce: 7n, block: 3n };
    expect(decodeLogs(DEPOSITORY, [started, countered, finalized])).toEqual(ok([
      { _tag: "dispute_started", ...fact, index: 0n },
      { _tag: "dispute_countered", ...fact, index: 1n },
      { _tag: "dispute_finalized", ...fact, index: 2n },
    ] satisfies readonly ChainEvent[]));
  });

  test("R-WATCH-CLOSED an event the Depository has never emitted is a fault, not a miss", () => {
    const reserve = logOf("ReserveUpdated", { entity: LEFT, tokenId: 1n, newBalance: 2n }, 1n, 0n);
    const log: RawLog = { ...reserve, topics: [LEFT] };
    expect(decodeLog(DEPOSITORY, log)).toEqual(err({ _tag: "unknown_event", block: 1n, index: 0n, topic: LEFT }));
    const bare = { ...log, topics: [] };
    expect(decodeLog(DEPOSITORY, bare)).toEqual(err({ _tag: "unknown_event", block: 1n, index: 0n, topic: "" }));
  });

  test("R-WATCH-CLOSED a log of another address is a fault: the node is asked for the Depository's logs", () => {
    const stranger = must(address(hexOf(0xbadn, 20)));
    const log = logOf("AccountEpochAdvanced", { left: LEFT, right: RIGHT, ondeltaEpoch: 1n }, 2n, 0n);
    const refused = err({ _tag: "foreign_log" as const, block: 2n, index: 0n, address: stranger });
    expect(decodeLog(DEPOSITORY, { ...log, address: stranger })).toEqual(refused);
  });

  test("a log that is not the shape its signature says is a fault: topics, data, and whole words", () => {
    const good = logOf("AccountEpochAdvanced", { left: LEFT, right: RIGHT, ondeltaEpoch: 1n }, 2n, 0n);
    const bad = (log: RawLog) => decodeLog(DEPOSITORY, log);
    const fault = err({ _tag: "bad_log" as const, block: 2n, index: 0n, event: topicOf(READ_SIGNATURES[0] ?? "") });
    expect(bad({ ...good, topics: good.topics.slice(0, 2) })).toEqual(fault);
    expect(bad({ ...good, data: "0x" })).toEqual(fault);
    expect(bad({ ...good, data: `${good.data}00` })).toEqual(fault);
    expect(bad({ ...good, data: `${good.data}${hexOf(1n).slice(2)}` })).toEqual(fault);
    const loud = logOf("AccountEpochAdvanced", { left: LEFT, right: RIGHT, ondeltaEpoch: 0xabcdefn }, 2n, 0n);
    expect(bad({ ...loud, data: loud.data.toUpperCase().replace("0X", "0x") }).ok).toBe(false);
    const finalized = logOf("DisputeFinalized", {
      ...disputeArgs, finalProofbodyHash: hexOf(5n), finalizationEvidenceHash: hexOf(6n),
    }, 2n, 0n);
    expect(bad({ ...finalized, topics: finalized.topics.slice(0, 3) }).ok).toBe(false);
    expect(bad({ ...finalized, data: finalized.data.slice(0, -64) }).ok).toBe(false);
  });

  test("a fault in one log of a block range is the fault of the range, and no event of it is delivered", () => {
    const fine = logOf("AccountEpochAdvanced", { left: LEFT, right: RIGHT, ondeltaEpoch: 1n }, 2n, 0n);
    const bad: RawLog = { ...fine, index: 1n, topics: [LEFT] };
    expect(decodeLogs(DEPOSITORY, [fine, bad]).ok).toBe(false);
    expect(decodeLogs(DEPOSITORY, [fine]).ok).toBe(true);
  });

  test("an ignored event is none, not a fault", () => {
    const reserve = logOf("ReserveUpdated", { entity: LEFT, tokenId: 1n, newBalance: 2n }, 1n, 0n);
    expect(decodeLog(DEPOSITORY, reserve)).toEqual(ok(none));
  });

  test("hex is lowercase 0x text of the exact width", () => {
    expect(bytes32(hexOf(1n)).ok).toBe(true);
    expect(bytes32("0x01").ok).toBe(false);
    expect(bytes32(hexOf(0xabcn).toUpperCase().replace("0X", "0x")).ok).toBe(false);
    expect(bytes32(hexOf(1n).slice(2)).ok).toBe(false);
    expect(address(hexOf(1n, 20)).ok).toBe(true);
    expect(address(hexOf(1n, 32)).ok).toBe(false);
  });
});
