// A hub decides on its own clock whether to forward an inbound lock: one that ends beyond the lock horizon is not
// forwarded and its payer is told `deadline_too_far`, not `deadline_unsafe` (the horizon is a different fault from an
// onward lock that would not outlive the hub's own claim). On this branch the check is live: the Account's fold admits
// a lock within the horizon of its frame's clock, and a receiver accepts a frame up to 30 s ahead of its own clock, so
// a proposer 20 s ahead gets a lock at its own horizon admitted that the hub, on its clock, must not forward (the last
// test composes the three real checks). After R-CLOCK (#57) the receiver's scan holds the same horizon on the local
// clock, and this decision is defense in depth. The decision is driven directly, on Bob's real Entity state.
import { describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519";
import { ALICE, BOB, CAROL, NOW, TERMS, UNREGISTERED_J, aliceAddr, bobAddr, carolAddr, unwrap, verifiers, withTestJurisdiction } from "../xln_run.ts";
import {
  ACCOUNT_NETWORK_ALLOWANCE_MS, HTLC_MIN_FORWARD_TIMELOCK_MS, HTLC_TIMELOCK_DELTA_MS, MAX_LOCK_HORIZON_BLOCKS,
  MAX_LOCK_HORIZON_MS, applyAccountBody, applyRuntime, receiverClock, convertOutput, createEntity,
  createRuntime, forwardOutcome, replicaKey, spawn, tokenId,
  type AccountFrame, type Address, type EntityId, type EntityReplica, type EntityTx, type HtlcEnvelope, type HtlcInboundView,
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

  /** The reviewer's composition: each check is the real one, and the skew sits inside what a receiver accepts. */
  describe("a proposer 20 s ahead of its hub", () => {
    const SKEW = 20_000n;
    const hubNow = BigInt(BOB_CLOCK);
    const frameTs = hubNow + SKEW;
    const alice = (): { readonly state: Parameters<typeof applyAccountBody>[0]; readonly byLeft: boolean } => {
      const account = viewAt(BOB_CLOCK).replicas.get(ALICE)!;
      return { state: account.state, byLeft: account.state.account.id.left.toLowerCase() === ALICE.toLowerCase() };
    };
    const lockAt = (timelock: bigint) => ({
      type: "htlc_lock" as const, lockId: "0x" + "ef".repeat(32), hashlock: "0x" + "ef".repeat(32), amount: 200n,
      tokenId: unwrap(tokenId("1")), timelock, revealBeforeHeight: BigInt(NEAR_HEIGHT),
    });
    const foldsAt = (timelock: bigint): boolean => {
      const { state, byLeft } = alice();
      return applyAccountBody(state, lockAt(timelock), { byLeft, nowMs: frameTs, jHeight: 0n, accountHeight: 2n }).ok;
    };
    const frame = (timestamp: bigint): AccountFrame => ({
      timestamp, jHeight: 0n, height: 2n, txs: [],
      prevFrameHash: "0x" + "00".repeat(32), accountStateRoot: "0x" + "00".repeat(32), stateHash: "0x" + "00".repeat(32),
    });
    const atFrameHorizon = frameTs + BigInt(MAX_LOCK_HORIZON_MS);

    test("the skew is inside what a receiver accepts (30 s)", () => {
      expect(SKEW).toBeLessThan(ACCOUNT_NETWORK_ALLOWANCE_MS);
      expect(receiverClock(frame(frameTs), hubNow).ok).toBe(true);
      expect(receiverClock(frame(hubNow + ACCOUNT_NETWORK_ALLOWANCE_MS + 1n), hubNow).ok).toBe(false);
    });

    test("the Account's fold admits a lock at its frame's horizon and refuses one ms past it", () => {
      expect(MAX_LOCK_HORIZON_BLOCKS).toBeGreaterThan(NEAR_HEIGHT);
      expect(foldsAt(atFrameHorizon)).toBe(true);
      expect(foldsAt(atFrameHorizon + 1n)).toBe(false);
    });

    test("that admitted lock is beyond the hub's horizon: the hub rejects it as deadline_too_far instead of forwarding", () => {
      expect(decide(BOB_CLOCK, atFrameHorizon, NEAR_HEIGHT)).toEqual({ kind: "reject", reason: "deadline_too_far" });
    });
  });
});
