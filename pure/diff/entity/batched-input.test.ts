// Where one input ends and the next begins is transport packaging: og's dispatch ships the tx-only outputs one source
// frame sent an Entity as one input (core/runtime/delivery/dispatch.ts batchOutputsByTarget), while the retained outbox
// the rewrite commits holds one row each. The Entity fold must not tell the two apart: one input carrying two Account
// messages and two inputs carrying one each leave the same Runtime and send the same outputs.
import { describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519";
import { ALICE, BOB, CAROL, NOW, TERMS, UNREGISTERED_J, aliceAddr, bobAddr, carolAddr, unwrap, verifiers, withTestJurisdiction } from "../../xln_run.ts";
import {
  applyRuntime, canonicalEntityHashes, convertOutput, createEntity, createRuntime, spawn, stableJson, tokenId,
  type Address, type EntityId, type EntityTx, type RoutedEntityInput, type Runtime,
} from "../../xln.ts";

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
const open = (to: EntityId): EntityTx => ({
  type: "openAccount",
  data: { targetEntityId: to, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig } },
} as EntityTx);
const credit = (to: EntityId, amount: bigint): EntityTx =>
  ({ type: "extendCredit", data: { counterpartyEntityId: to, tokenId: unwrap(tokenId("1")), amount } });

/** One Runtime frame: the new runtime and the inputs its outbox routes. */
type Step = { readonly runtime: Runtime; readonly routed: readonly RoutedEntityInput[] };
const step = (rt: Runtime, input: RoutedEntityInput): Step => {
  const out = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: [input] }, context() as never));
  const clock = input.input.kind === "txs" ? input.input.timestamp : NOW;
  const routed = out.outbox.flatMap((o) =>
    "input" in o && o.input.kind === "txs" && o.input.txs.length === 0 && o.to === input.entityId ? [] : [unwrap(convertOutput(out.runtime, o, input.entityId, clock))]);
  return { runtime: out.runtime, routed };
};
/** Frames run until no input is left, delivering each output in order. */
const settle = (rt: Runtime, queue: readonly RoutedEntityInput[]): Runtime => {
  const [head, ...rest] = queue;
  if (head === undefined) return rt;
  const done = step(rt, head);
  return settle(done.runtime, [...rest, ...done.routed]);
};
/** Bob opens an Account with Alice and one with Carol; both are open and idle. */
const network = (): Runtime => {
  const spawned = spawn(spawn(spawn(withTestJurisdiction(createRuntime()), entityOf(ALICE)), entityOf(BOB)), entityOf(CAROL));
  return settle(spawned, [inputOf(BOB, [open(ALICE), open(CAROL)], NOW)]);
};
/** What a Runtime frame leaves: every Entity's state hash. */
const hashesOf = (rt: Runtime): string => stableJson(unwrap(canonicalEntityHashes(rt)));

describe("input boundaries: one input with two Account messages is two inputs with one each", () => {
  /** Alice and Carol each extend Bob credit in one clock tick; the two Account proposals are Bob's inputs. */
  const proposals = () => {
    const alice = step(network(), inputOf(ALICE, [credit(BOB, 7n)], NOW + 1000n));
    const carol = step(alice.runtime, inputOf(CAROL, [credit(BOB, 8n)], NOW + 1000n));
    const toBob = (routed: readonly RoutedEntityInput[]) => routed.filter((r) => r.entityId === BOB);
    return { runtime: carol.runtime, first: toBob(alice.routed), second: toBob(carol.routed) };
  };
  const merged = (a: RoutedEntityInput, b: RoutedEntityInput): RoutedEntityInput =>
    a.input.kind === "txs" && b.input.kind === "txs" ? { ...a, input: { ...a.input, txs: [...a.input.txs, ...b.input.txs] } } : a;

  test("Bob's frame is the same, and so are its outputs", () => {
    const p = proposals();
    expect(p.first.length).toBe(1);
    expect(p.second.length).toBe(1);
    const separate = unwrap(applyRuntime(p.runtime, { runtimeTxs: [], entityInputs: [p.first[0]!, p.second[0]!] }, context() as never));
    const batched = unwrap(applyRuntime(p.runtime, { runtimeTxs: [], entityInputs: [merged(p.first[0]!, p.second[0]!)] }, context() as never));
    // Bob did fold both messages: his Runtime moved, and folding one alone leaves another Runtime
    const alone = unwrap(applyRuntime(p.runtime, { runtimeTxs: [], entityInputs: [p.first[0]!] }, context() as never));
    expect(hashesOf(batched.runtime)).not.toBe(hashesOf(p.runtime));
    expect(hashesOf(batched.runtime)).not.toBe(hashesOf(alone.runtime));
    expect(hashesOf(batched.runtime)).toBe(hashesOf(separate.runtime));
    expect(stableJson(batched.outbox)).toBe(stableJson(separate.outbox));
  });
});
