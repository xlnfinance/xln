import { describe, expect, test } from "bun:test";
import { EventFragment } from "ethers";
import { err, ok } from "../kernel/core/result.ts";
import { none } from "../kernel/core/option.ts";
import { tokenOf } from "../account/fixtures.ts";
import {
  bytes32, address, decodeLog, decodeLogs, IGNORED, READ_SIGNATURES, topicOf, type ChainEvent, type RawLog,
} from "./log.ts";
import {
  bodyHashOf, DEPOSITORY, DEPOSITORY_ABI, entityOf, hashOf, hexOf, lifecyclePhases, logOf, must,
} from "./fixtures.ts";

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
    // AccountSettled and SecretRevealed are read too and have tests of their own below.
    const read = new Set(["AccountEpochAdvanced", "DisputeStarted", "CounterDisputeRegistered", "DisputeFinalized"]);
    const phases = Object.values(lifecyclePhases);
    const logged = (e: (typeof phases)[number]["events"][number], p: number) =>
      ({ e, log: logOf(e.name, e.args, BigInt(p + 1), BigInt(e.logIndex)) });
    const seen = phases.flatMap((phase, p) => phase.events.map((e) => logged(e, p)))
      .filter(({ e }) => e.name !== "AccountSettled" && e.name !== "SecretRevealed");
    expect(seen.length).toBeGreaterThan(10);
    seen.forEach(({ e, log }) => {
      const decoded = decodeLog(DEPOSITORY, log);
      expect(decoded.ok).toBe(true);
      expect(decoded.ok && decoded.value._tag === "some").toBe(read.has(e.name));
    });
    expect(seen.filter(({ e }) => read.has(e.name)).length).toBeGreaterThanOrEqual(3);
  });

  test("R-J-COLLATERAL the real deposit and settlement read the collateral and ondelta the contract stored", () => {
    const settled = Object.values(lifecyclePhases)
      .flatMap((phase) => phase.events.filter((e) => e.name === "AccountSettled"));
    const read = settled.map((e, i) => must(decodeLog(DEPOSITORY, logOf(e.name, e.args, BigInt(i + 1), 0n))));
    const holdings = read.map((found) => (found._tag === "some" && found.value._tag === "account_settled"
      ? found.value.holdings.map(({ token, collateral, ondelta }) => [token, collateral, ondelta]) : []));
    expect(holdings).toEqual([[[1n, 100n, 100n]], [[1n, 90n, 90n]]]);
  });

  type Row = Readonly<{ token: bigint; collateral: bigint; high: bigint; low: bigint }>;

  const settledLog = (rows: readonly Row[], left = LEFT, right = RIGHT): RawLog =>
    logOf("AccountSettled", {
      settled: [[left, right, rows.map((r) => [r.token, 1n, 2n, r.collateral, [r.high, r.low]]), 7n]],
    }, 6n, 1n);

  const heldBy = (log: RawLog) => {
    const found = must(decodeLog(DEPOSITORY, log));
    return found._tag === "some" && found.value._tag === "account_settled" ? found.value : undefined;
  };

  test("R-J-COLLATERAL an AccountSettled is its entities and what it holds per token, an Int512 as words", () => {
    const rows = [
      { token: 1n, collateral: 100n, high: 0n, low: 100n },
      { token: 3n, collateral: 5n, high: -1n, low: 2n ** 256n - 1n },
      { token: 4n, collateral: 0n, high: 2n, low: 9n },
    ];
    expect(heldBy(settledLog(rows))).toEqual({
      _tag: "account_settled", block: 6n, blockHash: hashOf(6n), index: 1n, left: LEFT, right: RIGHT,
      holdings: [
        { token: tokenOf(1n), collateral: 100n, ondelta: 100n },
        { token: tokenOf(3n), collateral: 5n, ondelta: -1n },
        { token: tokenOf(4n), collateral: 0n, ondelta: 2n * 2n ** 256n + 9n },
      ],
    });
    expect(heldBy(settledLog([]))?.holdings).toEqual([]);
  });

  test("R-J-COLLATERAL an AccountSettled of a shape the Depository does not emit is a fault", () => {
    const good = settledLog([{ token: 1n, collateral: 100n, high: 0n, low: 100n }]);
    const word = (data: string, at: number, value: bigint): string =>
      `${data.slice(0, 2 + at * 64)}${value.toString(16).padStart(64, "0")}${data.slice(2 + (at + 1) * 64)}`;
    const at = { block: 6n, blockHash: hashOf(6n), index: 1n };
    const fault = err({ _tag: "bad_log" as const, ...at, event: topicOf(READ_SIGNATURES[1] ?? "") });
    const faulty = [
      { ...good, topics: [...good.topics, LEFT] },
      { ...good, data: good.data.slice(0, -64) },
      { ...good, data: `${good.data}${"00".repeat(32)}` },
      { ...good, data: `${good.data}${"00".repeat(32 * 6)}` },
      { ...good, data: word(good.data, 0, 64n) },
      { ...good, data: word(good.data, 1, 2n) },
      { ...good, data: word(good.data, 2, 64n) },
      { ...good, data: word(good.data, 5, 160n) },
      { ...good, data: word(good.data, 7, 2n) },
      { ...good, data: word(good.data, 7, 0n) },
      settledLog([{ token: 1n, collateral: 1n, high: 0n, low: 1n }], RIGHT, LEFT),
      settledLog([{ token: 1n, collateral: 1n, high: 0n, low: 1n }], LEFT, LEFT),
    ];
    faulty.forEach((log) => expect(decodeLog(DEPOSITORY, log)).toEqual(fault));
  });


  test("an epoch advance reads its two entities from the topics and its epoch from the data", () => {
    const log = logOf("AccountEpochAdvanced", { left: LEFT, right: RIGHT, ondeltaEpoch: 9n }, 4n, 2n);
    expect(decodeLog(DEPOSITORY, log)).toEqual(ok({
      _tag: "some",
      value: {
        _tag: "epoch_advanced", block: 4n, blockHash: hashOf(4n), index: 2n, left: LEFT, right: RIGHT, epoch: 9n,
      },
    }));
  });

  test("R-DISPUTE-FREEZE a revealed secret reads hashlock and revealer from topics, the secret from data", () => {
    const log = logOf("SecretRevealed", { hashlock: hexOf(7n), revealer: LEFT, secret: hexOf(8n) }, 5n, 1n);
    expect(decodeLog(DEPOSITORY, log)).toEqual(ok({
      _tag: "some",
      value: {
        _tag: "secret_revealed", block: 5n, blockHash: hashOf(5n), index: 1n, hashlock: must(bytes32(hexOf(7n))),
        revealer: LEFT, secret: must(bytes32(hexOf(8n))),
      },
    }));
    const at = { block: 5n, blockHash: hashOf(5n), index: 1n };
    const fault = err({ _tag: "bad_log" as const, ...at, event: log.topics[0] ?? "" });
    const bad = [
      { ...log, topics: log.topics.slice(0, 2) }, { ...log, data: `${log.data}${"00".repeat(32)}` },
      { ...log, data: "0x" },
    ];
    bad.forEach((broken) => expect(decodeLog(DEPOSITORY, broken)).toEqual(fault));
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
    const fact = { sender: RIGHT, counter: LEFT, nonce: 7n, block: 3n, blockHash: hashOf(3n) };
    expect(decodeLogs(DEPOSITORY, [started, countered, finalized])).toEqual(ok([
      { _tag: "dispute_started", ...fact, proposerIsLeft: true, bodyHash: bodyHashOf(1n), timeout: 5n, index: 0n },
      { _tag: "dispute_countered", ...fact, proposerIsLeft: false, bodyHash: bodyHashOf(4n), index: 1n },
      { _tag: "dispute_finalized", ...fact, index: 2n },
    ] satisfies readonly ChainEvent[]));
  });

  test("R-WATCH-CLOSED an event the Depository has never emitted is a fault, not a miss", () => {
    const reserve = logOf("ReserveUpdated", { entity: LEFT, tokenId: 1n, newBalance: 2n }, 1n, 0n);
    const log: RawLog = { ...reserve, topics: [LEFT] };
    const at = { block: 1n, blockHash: hashOf(1n), index: 0n };
    expect(decodeLog(DEPOSITORY, log)).toEqual(err({ _tag: "unknown_event", ...at, topic: LEFT }));
    const bare = { ...log, topics: [] };
    expect(decodeLog(DEPOSITORY, bare)).toEqual(err({ _tag: "unknown_event", ...at, topic: "" }));
  });

  test("R-WATCH-CLOSED a log of another address is a fault: the node is asked for the Depository's logs", () => {
    const stranger = must(address(hexOf(0xbadn, 20)));
    const log = logOf("AccountEpochAdvanced", { left: LEFT, right: RIGHT, ondeltaEpoch: 1n }, 2n, 0n);
    const at = { block: 2n, blockHash: hashOf(2n), index: 0n };
    const refused = err({ _tag: "foreign_log" as const, ...at, address: stranger });
    expect(decodeLog(DEPOSITORY, { ...log, address: stranger })).toEqual(refused);
  });

  test("a log that is not the shape its signature says is a fault: topics, data, and whole words", () => {
    const good = logOf("AccountEpochAdvanced", { left: LEFT, right: RIGHT, ondeltaEpoch: 1n }, 2n, 0n);
    const bad = (log: RawLog) => decodeLog(DEPOSITORY, log);
    const at = { block: 2n, blockHash: hashOf(2n), index: 0n };
    const fault = err({ _tag: "bad_log" as const, ...at, event: topicOf(READ_SIGNATURES[0] ?? "") });
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
