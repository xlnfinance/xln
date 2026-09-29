// A hub decides on its own clock whether to forward an inbound lock: one that ends beyond the lock horizon is not
// forwarded and its payer is told `deadline_too_far`, not `deadline_unsafe` (the horizon is a different fault from an
// onward lock that would not outlive the hub's own claim). End to end this is unreachable by any legal clock skew: the
// Account admits a lock only within the horizon of its frame's clock, and a frame more than 30 s ahead of its receiver
// is refused; so the decision is driven directly, on Bob's real Entity state, with the hub's clock set behind.
import { describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519";
import { ALICE, BOB, CAROL, NOW, TERMS, UNREGISTERED_J, aliceAddr, bobAddr, carolAddr, unwrap, verifiers, withTestJurisdiction } from "../xln_run.ts";
import {
  HTLC_MIN_FORWARD_TIMELOCK_MS, HTLC_TIMELOCK_DELTA_MS, MAX_LOCK_HORIZON_MS, applyRuntime, convertOutput, createEntity,
  createRuntime, forwardOutcome, replicaKey, spawn, tokenId,
  type Address, type EntityId, type EntityReplica, type EntityTx, type HtlcEnvelope, type HtlcInboundView,
  type PreparedHtlcBinding, type PreparedHtlcEntry, type RoutedEntityInput, type Runtime,
} from "../xln.ts";

const JUR = TERMS.domain;
const ENTITY_KEYS = new Map([ALICE, BOB, CAROL].map((id, i) => {
  const priv = new Uint8Array(32).fill(i + 7);
  return [id, { priv: "0x" + Buffer.from(priv).toString("hex"), pub: "0x" + Buffer.from(x25519.getPublicKey(priv)).toString("hex") }] as const;
}));
const SIGNERS = new Map<EntityId, Address>([[ALICE, aliceAddr], [BOB, bobAddr], [CAROL, carolAddr]]);
const entityOf = (id: EntityId) => unwrap(createEntity({
  id, jurisdiction: JUR, threshold: 1n, members: new Map([[SIGNERS.get(id)!, { shares: 1n }]]),
  committed: { entityEncryptionPublicKey: ENTITY_KEYS.get(id)!.pub }, jurisdictionConfig: UNREGISTERED_J,
}));
const context = () => ({ ...verifiers, htlcInfra: (id: EntityId) => ({ profiles: [], online: () => true, encryptionPrivateKey: ENTITY_KEYS.get(id)!.priv }) });
const inputOf = (id: EntityId, txs: EntityTx[], timestamp: bigint): RoutedEntityInput =>
  ({ entityId: id, signerId: SIGNERS.get(id)!, input: { kind: "txs", timestamp, txs } });
const open = (to: EntityId, creditAmount?: bigint): EntityTx => ({
  type: "openAccount",
  data: { targetEntityId: to, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig }, ...(creditAmount === undefined ? {} : { creditAmount, tokenId: unwrap(tokenId("1")) }) },
} as EntityTx);
const credit = (to: EntityId, amount: bigint): EntityTx =>
  ({ type: "extendCredit", data: { counterpartyEntityId: to, tokenId: unwrap(tokenId("1")), amount } });
const step = (rt: Runtime, input: RoutedEntityInput) => {
  const out = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: [input] }, context() as never));
  const clock = input.input.kind === "txs" ? input.input.timestamp : NOW;
  const routed = out.outbox.flatMap((o) =>
    "input" in o && o.input.kind === "txs" && o.input.txs.length === 0 && o.to === input.entityId ? [] : [unwrap(convertOutput(out.runtime, o, input.entityId, clock))]);
  return { runtime: out.runtime, routed };
};
const settle = (rt: Runtime, queue: readonly RoutedEntityInput[]): Runtime => {
  const [head, ...rest] = queue;
  if (head === undefined) return rt;
  const done = step(rt, head);
  return settle(done.runtime, [...rest, ...done.routed]);
};
/** Alice -- Bob -- Carol: Bob opens both Accounts and extends Alice 1000 of credit; Carol extends Bob 1000. */
const network = (): Runtime => {
  const spawned = spawn(spawn(spawn(withTestJurisdiction(createRuntime()), entityOf(ALICE)), entityOf(BOB)), entityOf(CAROL));
  const opened = settle(spawned, [inputOf(BOB, [open(ALICE, 1000n), open(CAROL)], NOW)]);
  return settle(opened, [inputOf(CAROL, [credit(BOB, 1000n)], NOW + 100n)]);
};
const replicaOf = (rt: Runtime, id: EntityId): EntityReplica => rt.entities.get(replicaKey(id, SIGNERS.get(id)!))!;

const BOB_CLOCK = Number(NOW);
const INNER = { ciphertext: "0x00" } as unknown as HtlcEnvelope;
/** Bob's inbound view at his own clock, on his real state: he can forward to Carol, who is online. */
const viewAt = (timestamp: number): HtlcInboundView => {
  const bob = replicaOf(network(), BOB);
  return {
    state: bob.state, replicas: bob.accountReplicas, timestamp,
    publicKey: ENTITY_KEYS.get(BOB)!.pub, privateKey: ENTITY_KEYS.get(BOB)!.priv, online: () => true,
  };
};
const lock = (timelock: bigint, revealBeforeHeight: number): PreparedHtlcBinding => ({
  fromEntityId: ALICE, toEntityId: BOB, domain: JUR, accountFrameHash: "0x" + "ab".repeat(32), accountHeight: 2,
  envelopeHash: "0x" + "cd".repeat(32), hashlock: "0x" + "ef".repeat(32), tokenId: 1, amount: 200n, timelock, revealBeforeHeight,
});
const decide = (timestamp: number, timelock: bigint, revealBeforeHeight: number): PreparedHtlcEntry["outcome"] =>
  forwardOutcome(viewAt(timestamp), lock(timelock, revealBeforeHeight), { nextHop: CAROL, forwardAmount: "100", innerEnvelope: INNER }).outcome;

describe("a hub decides on its own clock whether to forward an inbound lock", () => {
  const NEAR_HEIGHT = 20;
  const safeEnd = BigInt(BOB_CLOCK) + BigInt(HTLC_TIMELOCK_DELTA_MS + HTLC_MIN_FORWARD_TIMELOCK_MS) + 1n;

  test("a lock that outlives the onward delta and the first hop's margin is forwarded (control)", () => {
    expect(decide(BOB_CLOCK, safeEnd, NEAR_HEIGHT).kind).toBe("forward");
  });

  test("a lock ending beyond the horizon of the hub's clock is rejected as deadline_too_far, not forwarded", () => {
    const far = BigInt(BOB_CLOCK) + BigInt(MAX_LOCK_HORIZON_MS) + 1n;
    expect(decide(BOB_CLOCK, far, NEAR_HEIGHT)).toEqual({ kind: "reject", reason: "deadline_too_far" });
  });

  test("the same lock is fine on a clock that has caught up: the verdict is the hub's clock, not the lock's", () => {
    const far = BigInt(BOB_CLOCK) + BigInt(MAX_LOCK_HORIZON_MS) + 1n;
    expect(decide(BOB_CLOCK + 2, far, NEAR_HEIGHT).kind).toBe("forward");
  });

  test("a lock exactly at the horizon is not too far", () => {
    const edge = BigInt(BOB_CLOCK) + BigInt(MAX_LOCK_HORIZON_MS);
    expect(decide(BOB_CLOCK, edge, NEAR_HEIGHT).kind).toBe("forward");
  });

  test("a lock the onward delta would leave without margin is deadline_unsafe, a different fault", () => {
    const tight = BigInt(BOB_CLOCK) + BigInt(HTLC_TIMELOCK_DELTA_MS + HTLC_MIN_FORWARD_TIMELOCK_MS);
    expect(decide(BOB_CLOCK, tight, NEAR_HEIGHT)).toEqual({ kind: "reject", reason: "deadline_unsafe" });
  });
});
