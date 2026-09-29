// A lock the proposer's own Account frame refuses ends its payment route (og failedProposalHtlcFollowup): an originated
// payment leaves no paybook entry, a forwarded one fails back upstream. Found by the disputes walk (seeds 0x30de2/3):
// the rewrite dropped the refused lock from the frame and kept the paybook entry for ever.
import { describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519";
import { withDeterministicHtlcTestSecret } from "../../core/protocol/htlc/test-secret-capability.ts";
import * as ogAdmission from "../../core/entity/paybook/payment-admission.ts";
import { ALICE, BOB, CAROL, NOW, TERMS, UNREGISTERED_J, aliceAddr, bobAddr, carolAddr, unwrap, verifiers, withTestJurisdiction } from "../xln_run.ts";
import {
  applyRuntime, convertOutput, createEntity, createRuntime, replicaKey, spawn, tokenId,
  type Address, type Binary, type EntityId, type EntityReplica, type EntityTx, type RoutedEntityInput, type Runtime,
} from "../xln.ts";

const JUR = TERMS.domain;
const SECRET = "0x" + "42".repeat(32);
const ONE_DAY = 86_400_000n;
const ENTITY_KEYS = new Map([ALICE, BOB, CAROL].map((id, i) => {
  const priv = new Uint8Array(32).fill(i + 7);
  return [id, { priv: "0x" + Buffer.from(priv).toString("hex"), pub: "0x" + Buffer.from(x25519.getPublicKey(priv)).toString("hex") }] as const;
}));
const SIGNERS = new Map<EntityId, Address>([[ALICE, aliceAddr], [BOB, bobAddr], [CAROL, carolAddr]]);
const entityOf = (id: EntityId) => unwrap(createEntity({
  id, jurisdiction: JUR, threshold: 1n, members: new Map([[SIGNERS.get(id)!, { shares: 1n }]]),
  committed: { entityEncryptionPublicKey: ENTITY_KEYS.get(id)!.pub }, jurisdictionConfig: UNREGISTERED_J,
}));
const profile = (id: EntityId, accounts: readonly object[], meta: object = {}): Binary =>
  ({ entityId: id, entityEncryptionPublicKey: ENTITY_KEYS.get(id)!.pub, name: id.slice(-4), metadata: { isHub: false, routingFeePPM: 100, baseFee: 0n, ...meta }, accounts }) as unknown as Binary;
const caps = (inC: bigint, outC: bigint) => new Map([[1, { inCapacity: inC, outCapacity: outC }]]);
const profiles = (): Binary[] => [
  profile(ALICE, []),
  profile(BOB, [{ counterpartyId: ALICE, domain: JUR, tokenCapacities: caps(1000n, 0n) }, { counterpartyId: CAROL, domain: JUR, tokenCapacities: caps(0n, 1000n) }], { routingFeePPM: 5000, baseFee: 1n }),
  profile(CAROL, []),
];
const payment = (): EntityTx => withDeterministicHtlcTestSecret({
  type: "htlcPayment",
  data: { targetEntityId: CAROL, tokenId: 1, amount: 100n, maxSenderDebit: 200n, route: [ALICE, BOB, CAROL], deliveryMode: "instant" },
}, SECRET) as unknown as EntityTx;
const context = () => {
  const hashlock = ogAdmission.hashRawHtlcPaymentTx(payment() as never);
  return {
    ...verifiers,
    htlcInfra: (id: EntityId) => ({
      profiles: profiles(), online: () => true, encryptionPrivateKey: ENTITY_KEYS.get(id)!.priv,
      ...(id === ALICE ? { secretFor: (h: string) => (h === hashlock ? SECRET : undefined) } : {}),
    }),
  };
};
const inputOf = (id: EntityId, txs: EntityTx[], timestamp: bigint): RoutedEntityInput =>
  ({ entityId: id, signerId: SIGNERS.get(id)!, input: { kind: "txs", timestamp, txs } });
const open = (to: EntityId, creditAmount?: bigint): EntityTx => ({
  type: "openAccount",
  data: { targetEntityId: to, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig }, ...(creditAmount === undefined ? {} : { creditAmount, tokenId: unwrap(tokenId("1")) }) },
} as EntityTx);
const credit = (to: EntityId, amount: bigint): EntityTx =>
  ({ type: "extendCredit", data: { counterpartyEntityId: to, tokenId: unwrap(tokenId("1")), amount } });
const replicaOf = (rt: Runtime, id: EntityId): EntityReplica => rt.entities.get(replicaKey(id, SIGNERS.get(id)!))!;

/** One Runtime frame: the new runtime and the inputs its outbox routes. */
type Step = { readonly runtime: Runtime; readonly routed: readonly RoutedEntityInput[] };
const step = (rt: Runtime, input: RoutedEntityInput): Step => {
  const out = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: [input] }, context() as never));
  const clock = input.input.kind === "txs" ? input.input.timestamp : NOW;
  const routed = out.outbox.flatMap((o) =>
    "input" in o && o.input.kind === "txs" && o.input.txs.length === 0 && o.to === input.entityId ? [] : [unwrap(convertOutput(out.runtime, o, input.entityId, clock))]);
  return { runtime: out.runtime, routed };
};
/** Frames run until no input is left, delivering each output in order at the clock of the frame that made it. */
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
const paybookHashlocks = (rt: Runtime, id: EntityId): readonly string[] => [...(replicaOf(rt, id).state.paybook?.entries.keys() ?? [])];
const mempoolTypes = (rt: Runtime, id: EntityId, peer: EntityId): readonly string[] =>
  (replicaOf(rt, id).accountReplicas.get(peer) as unknown as { mempool: readonly { type: string }[] }).mempool.map((t) => t.type);

const deltaOf = (rt: Runtime, id: EntityId, peer: EntityId) =>
  replicaOf(rt, id).accountReplicas.get(peer)!.state.account.deltas.get(unwrap(tokenId("1")))!;
const lockCount = (rt: Runtime, id: EntityId, peer: EntityId): number => replicaOf(rt, id).accountReplicas.get(peer)!.state.locks.size;
const later = (input: RoutedEntityInput): RoutedEntityInput =>
  ({ ...input, input: { ...input.input, timestamp: NOW + ONE_DAY } }) as RoutedEntityInput;

/** `holder` proposed a frame to `peer` that `peer` answered, but the answer is held back: the runtime and the answer. */
type Held = { readonly runtime: Runtime; readonly answer: RoutedEntityInput };
const holdAnswer = (holder: EntityId, peer: EntityId): Held => {
  const proposed = step(network(), inputOf(holder, [credit(peer, 5n)], NOW + 1000n));
  const answered = step(proposed.runtime, proposed.routed[0]!);
  return { runtime: answered.runtime, answer: answered.routed[0]! };
};

describe("failed lock: a lock the proposal refuses ends its payment route", () => {
  /**
   * Alice's Account with Bob has a frame out that Bob has not answered, so the lock of her new payment waits in its
   * mempool. A day later Bob's answer commits the frame and Alice proposes the lock, which has expired by then.
   */
  test("an originated payment whose lock is refused at proposal leaves no paybook entry", () => {
    const held = holdAnswer(ALICE, BOB);
    const paying = step(held.runtime, inputOf(ALICE, [payment()], NOW + 2000n));
    expect(paybookHashlocks(paying.runtime, ALICE).length).toBe(1);
    expect(mempoolTypes(paying.runtime, ALICE, BOB)).toEqual(["htlc_lock"]);
    const answered = step(paying.runtime, later(held.answer));
    expect(mempoolTypes(answered.runtime, ALICE, BOB)).toEqual([]);
    expect(paybookHashlocks(answered.runtime, ALICE)).toEqual([]);
  });

  /**
   * Bob's Account with Carol has a frame out that Carol has not answered, so the lock Bob forwards for Alice's payment
   * waits in its mempool and expires there. Bob's proposal refuses it: he fails the payment back to Alice, and both
   * routes end with no lock left and no money moved.
   */
  test("a forwarded payment whose next lock is refused at proposal fails back upstream", () => {
    const held = holdAnswer(BOB, CAROL);
    const paying = step(held.runtime, inputOf(ALICE, [payment()], NOW + 2000n));
    const forwarded = settle(paying.runtime, paying.routed);
    expect(mempoolTypes(forwarded, BOB, CAROL)).toEqual(["htlc_lock"]);
    const failed = settle(forwarded, [later(held.answer)]);
    expect(mempoolTypes(failed, BOB, CAROL)).toEqual([]);
    expect(paybookHashlocks(failed, BOB)).toEqual([]);
    expect(paybookHashlocks(failed, ALICE)).toEqual([]);
    expect(lockCount(failed, ALICE, BOB)).toBe(0);
    expect(lockCount(failed, BOB, ALICE)).toBe(0);
    expect(deltaOf(failed, ALICE, BOB).offdelta).toBe(0n);
  });
});
