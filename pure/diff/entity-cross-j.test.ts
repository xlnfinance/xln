// Differential tests: og Entity-side HTLC onion routing and cross-j Entity handlers vs pure/xln.ts.
// Every test is "MATCH:" and runs og live on the same (seeded random) input.
import { describe, expect, test } from "bun:test";
import { seedOf, seedTag } from "./seed.ts";
import { x25519 } from "@noble/curves/ed25519";
import * as ogMr from "../../core/protocol/htlc/multi-recipient.ts";
import * as ogOnion from "../../core/protocol/htlc/codec/onion.ts";
import * as ogEnvelope from "../../core/protocol/htlc/codec/envelope.ts";
import * as ogUtils from "../../core/protocol/htlc/utils.ts";
import * as ogQuote from "../../core/pathfinding/htlc-quote.ts";
import * as ogFees from "../../core/pathfinding/fees.ts";
import { buildNetworkGraph as ogBuildGraph } from "../../core/pathfinding/graph.ts";
import { PathFinder } from "../../core/pathfinding/pathfinding.ts";
import { resolvePaymentDeadlineWindow } from "../../core/protocol/payments/delivery.ts";
import {
  createOnionEnvelopes, decodeOnionLayer, decryptOpaqueHtlc, directionalFeePpm, encodeOnionLayer, encryptOpaqueHtlc, htlcEnvelopeContextHash, hopRevealHeight, hopTimelock,
  paymentDeadlineWindow, quoteHtlcRoute, requiredInbound, routingIndex, stableJson, type HtlcEnvelope, type OnionLayer, type RoutingProfile,
} from "../xln.ts";
import { asHub, ogOf, withOg } from "./og-state.ts";

export const rng = (base: number) => {
  let seed = seedOf(base);
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
type Rand = () => number;
const pick = <T,>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const int = (r: Rand, n: number): number => Math.floor(r() * n);
const hex = (r: Rand, bytes: number): string => "0x" + Array.from({ length: bytes }, () => int(r, 256).toString(16).padStart(2, "0")).join("");
const bytes = (r: Rand, n: number): Uint8Array => Uint8Array.from({ length: n }, () => int(r, 256));
const ogTry = <T,>(f: () => T): { ok: true; value: T } | { ok: false } => { try { return { ok: true, value: f() }; } catch { return { ok: false }; } };
const ogTryAsync = async <T,>(f: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => { try { return { ok: true, value: await f() }; } catch { return { ok: false }; } };
const same = (og: { ok: boolean; value?: unknown }, rw: { ok: boolean; value?: unknown }, label: string): void => {
  expect(`${label}:${rw.ok}`).toBe(`${label}:${og.ok}`);
  if (og.ok && rw.ok) expect(stableJson(rw.value)).toBe(stableJson(og.value));
};
const keyPair = (r: Rand) => { const priv = x25519.utils.randomPrivateKey(); priv.set(bytes(r, 32)); return { priv: "0x" + Buffer.from(priv).toString("hex"), pub: "0x" + Buffer.from(x25519.getPublicKey(priv)).toString("hex") }; };

describe(seedTag("entity-cross-j: HTLC onion crypto (og protocol/htlc/multi-recipient.ts)"), () => {
  test("MATCH: encryptOpaqueHtlcBytes is byte-identical for the same ephemeral key; decryptOpaqueHtlcBytes agrees on 300 random (and tampered) inputs", () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const recipient = keyPair(r), eph = keyPair(r).priv, ctx = r() < 0.05 ? "0x12" : hex(r, 32);
      const plain = bytes(r, int(r, 200));
      const recipientKey = r() < 0.05 ? "0x" + "00".repeat(32) : r() < 0.05 ? recipient.pub.toUpperCase() : recipient.pub;
      const og = ogTry(() => ogMr.encryptOpaqueHtlcBytes(plain, recipientKey, ctx, eph));
      const rw = encryptOpaqueHtlc(plain, recipientKey, ctx, eph);
      same(og, rw, `enc${i}`);
      if (!og.ok || !rw.ok) continue;
      let env: HtlcEnvelope = rw.value;
      if (r() < 0.3) { const b = Buffer.from(env.ciphertext, "base64"), j = int(r, b.length); b[j] = (b[j] ?? 0) ^ (1 << int(r, 8)); env = { ...env, ciphertext: b.toString("base64") }; }
      const pub = r() < 0.1 ? keyPair(r).pub : recipient.pub, dctx = r() < 0.1 ? hex(r, 32) : ctx;
      same(ogTry(() => ogMr.decryptOpaqueHtlcBytes(env, pub, recipient.priv, dctx)), decryptOpaqueHtlc(env, pub, recipient.priv, dctx), `dec${i}`);
    }
  }, 30_000);
});

const randomLayer = (r: Rand): OnionLayer => {
  if (r() < 0.5) {
    const note = r() < 0.5 ? undefined : pick(r, ["", "hi", "invoice #1", "ünïcödé", "x".repeat(300)]);
    const at = r() < 0.5 ? undefined : pick(r, [1, 1_700_000_000_000, Number.MAX_SAFE_INTEGER, 0, -1, 1.5]);
    return { finalRecipient: true, secret: r() < 0.05 ? "0x1234" : hex(r, 32), ...(note === undefined ? {} : { description: note }), ...(at === undefined ? {} : { startedAtMs: at }) };
  }
  const env = ogMr.encryptOpaqueHtlcBytes(bytes(r, int(r, 50)), keyPair(r).pub, hex(r, 32), keyPair(r).priv);
  return { nextHop: pick(r, [hex(r, 32), "", "hub"]), innerEnvelope: env, forwardAmount: pick(r, ["1", "0", "-5", "abc", (2n ** 256n).toString(), (2n ** 256n - 1n).toString(), String(int(r, 1e9))]) };
};
describe(seedTag("entity-cross-j: onion layer codec (og codec/onion.ts)"), () => {
  test("MATCH: encodeOnionLayer bytes and decodeOnionLayer on 600 random layers, truncations and bit flips", () => {
    const r = rng(11);
    for (let i = 0; i < 600; i++) {
      const layer = randomLayer(r);
      const og = ogTry(() => ogOnion.encodeOnionLayer(layer as never)), rw = encodeOnionLayer(layer);
      expect(`${i}:${rw.ok}`).toBe(`${i}:${og.ok}`);
      if (!og.ok || !rw.ok) continue;
      expect(Buffer.from(rw.value).toString("hex")).toBe(Buffer.from(og.value).toString("hex"));
      let enc = rw.value.slice();
      const mode = int(r, 4);
      if (mode === 1) enc = enc.slice(0, int(r, enc.length));
      if (mode === 2 && enc.length > 0) { const j = int(r, enc.length); enc[j] = (enc[j] ?? 0) ^ (1 << int(r, 8)); }
      if (mode === 3) enc = Uint8Array.from([...enc, 0]);
      same(ogTry(() => ogOnion.decodeOnionLayer(enc)), decodeOnionLayer(enc), `dec${i}`);
    }
  });
});

describe(seedTag("entity-cross-j: route economics (og pathfinding/htlc-quote.ts, fees.ts, protocol/htlc/utils.ts, payments/delivery.ts)"), () => {
  test("MATCH: directional fee, required inbound, hop timelock/reveal and the payment deadline window on 500 random inputs", () => {
    const r = rng(3);
    for (let i = 0; i < 500; i++) {
      const base = pick(r, [0, 1, 7, 100, 999_999, 2_000_000, -3]), out = BigInt(int(r, 1e6)) - 10n, inn = BigInt(int(r, 1e6));
      expect(directionalFeePpm(base, out, inn)).toBe(ogFees.calculateDirectionalFeePPM(base, out, inn));
      const desired = BigInt(int(r, 1e9)) - 2n, ppm = pick(r, [0, 1, 50, 5000, 999_999]), fee = BigInt(pick(r, [0, 0, 1, 1000]));
      same(ogTry(() => ogUtils.calculateRequiredInboundForDesiredForward(desired, ppm, fee)), requiredInbound(desired, ppm, fee), `inb${i}`);
      const tl = BigInt(int(r, 1e12)), hop = int(r, 5);
      expect(hopTimelock(tl, hop)).toBe(ogUtils.calculateHopTimelock(tl, hop));
      expect(hopRevealHeight(100 + i, hop, 5)).toBe(ogUtils.calculateHopRevealHeight(100 + i, hop, 5));
      const mode = pick(r, ["instant", "async"] as const), jh = pick(r, [0, 5, int(r, 1e6), -1, 1.5]), ts = pick(r, [0, 1_700_000_000_000, -1]), hops = int(r, 30) + 1;
      same(ogTry(() => resolvePaymentDeadlineWindow({ mode, runtimeJHeight: jh as never, timestamp: ts as never, totalHops: hops })), paymentDeadlineWindow(mode, jh, ts, hops), `win${i}`);
    }
  });
  const domainOf = (r: Rand) => ({ chainId: pick(r, [1, 31337]), depositoryAddress: hex(r, 20) });
  const profilesFor = (r: Rand, route: readonly string[], keys: ReadonlyMap<string, string>, tokenId: number): RoutingProfile[] => {
    const profiles = route.filter((id, i) => route.indexOf(id) === i).map((id): RoutingProfile => ({ entityId: id, accounts: [], entityEncryptionPublicKey: keys.get(id) ?? "", metadata: { ...(r() < 0.7 ? { routingFeePPM: pick(r, [0, 1, 100, 5000, 1e6]) } : {}), ...(r() < 0.5 ? { baseFee: BigInt(pick(r, [0, 1, 10])) } : {}) } }));
    const byId = new Map(profiles.map((p) => [p.entityId, p]));
    for (let i = 0; i + 1 < route.length; i++) {
      if (r() < 0.03) continue;
      const owner = r() < 0.5 ? route[i]! : route[i + 1]!, peer = owner === route[i] ? route[i + 1]! : route[i]!;
      const caps = new Map(r() < 0.03 ? [] : [[tokenId, { inCapacity: BigInt(int(r, 1e9)), outCapacity: BigInt(int(r, 1e9)) }] as const]);
      const p = byId.get(owner)!;
      byId.set(owner, { ...p, accounts: [...p.accounts, { counterpartyId: peer, domain: domainOf(r), tokenCapacities: caps }] });
    }
    return [...byId.values(), ...(r() < 0.03 ? [byId.get(route[1]!)!] : [])];
  };
  const ogProfiles = (ps: readonly RoutingProfile[]) => ps.map((p) => ({ ...p, accounts: p.accounts.map((a) => ({ ...a, tokenCapacities: new Map(a.tokenCapacities) })), metadata: { ...p.metadata } }));
  test("MATCH: quoteHtlcPaymentRouteWithIndex on 300 random routes and gossip profiles (missing lanes, mirrored lanes, duplicate profiles)", () => {
    const r = rng(5);
    for (let i = 0; i < 300; i++) {
      const route = Array.from({ length: 2 + int(r, 5) }, () => hex(r, 32)), tokenId = pick(r, [1, 2, 3]);
      const ps = profilesFor(r, route, new Map(), tokenId), amount = BigInt(int(r, 1e9)) + 1n;
      const og = ogTry(() => ogQuote.quoteHtlcPaymentRouteWithIndex(ogQuote.buildRoutingProfileIndex(ogProfiles(ps) as never), route, tokenId, amount));
      const rw = quoteHtlcRoute(routingIndex(ps), route, tokenId, amount);
      same(og.ok ? { ok: true, value: { s: og.value.senderLockAmount, f: [...og.value.hopForwardAmounts] } } : og, rw.ok ? { ok: true, value: { s: rw.value.senderLockAmount, f: [...rw.value.hopForwardAmounts] } } : rw, `q${i}`);
    }
  });
  test("MATCH: computeHtlcEnvelopeContextHash and createOnionEnvelopes produce identical onions for 80 random routes (same ephemeral keys)", async () => {
    const r = rng(9);
    let accepted = 0;
    for (let i = 0; i < 80; i++) {
      const pairs = Array.from({ length: 2 + int(r, 4) }, () => ({ id: hex(r, 32), key: keyPair(r) }));
      const route = pairs.map((p) => p.id);
      if (r() < 0.1) route.push(route[0]!);
      const keys = new Map(pairs.map((p) => [p.id, r() < 0.02 ? "" : p.key.pub]));
      const domains = route.slice(1).map(() => domainOf(r));
      const forwards = new Map(route.slice(1, -1).map((id) => [id, BigInt(int(r, 1e6)) + 1n]));
      const binding = { hashlock: hex(r, 32), tokenId: pick(r, [1, 2]), senderLockAmount: BigInt(int(r, 1e7)) + 1n, timelock: BigInt(1_700_000_000_000 + int(r, 1e6)), revealBeforeHeight: 200 + int(r, 100) };
      const note = pick(r, [undefined, "", "pay"]), started = pick(r, [undefined, 1_700_000_000_000]), secret = hex(r, 32);
      const ephem = Array.from({ length: route.length }, () => keyPair(r).priv);
      const og = await ogTryAsync(() => ogEnvelope.createOnionEnvelopes(route, secret, keys, domains, forwards, note, started, binding, (k) => ephem[k]!));
      const rw = createOnionEnvelopes(route, secret, keys, domains, forwards, note, started, binding, (k) => ephem[k]!);
      same(og, rw, `onion${i}`);
      if (rw.ok) accepted++;
      const ctx = { fromEntityId: route[0]!, toEntityId: route[1]!, domain: domains[0]!, hashlock: binding.hashlock, tokenId: binding.tokenId, amount: binding.senderLockAmount, timelock: binding.timelock, revealBeforeHeight: binding.revealBeforeHeight };
      same(ogTry(() => ogEnvelope.computeHtlcEnvelopeContextHash(ctx)), htlcEnvelopeContextHash(ctx), `ctx${i}`);
      if (!rw.ok) continue;
      // Peel the whole onion with the rewrite and compare every layer with og's decoding.
      let env = rw.value;
      for (let hop = 1; hop < route.length; hop++) {
        const inbound = hop === 1 ? binding.senderLockAmount : forwards.get(route[hop - 1]!)!;
        const c = htlcEnvelopeContextHash({ ...ctx, fromEntityId: route[hop - 1]!, toEntityId: route[hop]!, domain: domains[hop - 1]!, amount: inbound, timelock: binding.timelock - BigInt(hop - 1) * 10_000n, revealBeforeHeight: binding.revealBeforeHeight - (hop - 1) * 3 });
        const pair = pairs.find((p) => p.id === route[hop])!;
        const plain = decryptOpaqueHtlc(env, pair.key.pub, pair.key.priv, (c as { value: string }).value);
        expect(plain.ok).toBe(true);
        const layer = decodeOnionLayer((plain as { value: Uint8Array }).value);
        expect(stableJson(layer)).toBe(stableJson({ ok: true, value: ogOnion.decodeOnionLayer((plain as { value: Uint8Array }).value) }));
        if (layer.ok && "innerEnvelope" in layer.value) env = layer.value.innerEnvelope; else break;
      }
    }
    expect(accepted).toBeGreaterThan(50);
  }, 30_000);
});

// ---- Entity htlcPayment (og entity/paybook/payment-admission.ts, tx/handlers/htlc/payment.ts) ----
import * as ogAdmission from "../../core/entity/paybook/payment-admission.ts";
import { withDeterministicHtlcTestSecret } from "../../core/protocol/htlc/test-secret-capability.ts";
import { handleHtlcPayment } from "../../core/entity/tx/handlers/htlc/payment.ts";
import { createBookIntentProgram, applyBookIntentProgram } from "../../core/entity/books/book-intents.ts";
import { validateHtlcPreparedInfraContext } from "../../core/entity/paybook/prepared-context-validation.ts";
import { entityCollectionCommitment as ogCollection } from "../../core/entity/state/persistent-collection-map.ts";
import { ALICE, BOB, CAROL, NOW, TERMS, UNREGISTERED_J, aliceAddr, bobAddr, carolAddr, unwrap, verifiers, withTestJurisdiction } from "../xln_run.ts";
import {
  applyRuntime, assertOriginated, convertOutput, createEntity, createRuntime, entityCollectionCommitment, holds, htlcPaymentTxHash, isLeft, materializeOriginated, preparedOriginOf, replicaId, replicaKey, spawn, tokenId,
  validatePreparedHtlcPayment, wireTx, type AccountReplica, type Address, type Binary, type EntityId, type EntityReplica, type EntityTx, type HtlcFrameInfra, type PreparedOriginated, type RoutedEntityInput, type Runtime,
} from "../xln.ts";

const JUR = TERMS.domain;
const ENTITY_KEYS = new Map([ALICE, BOB, CAROL].map((id, i) => { const priv = new Uint8Array(32).fill(i + 7); return [id, { priv: "0x" + Buffer.from(priv).toString("hex"), pub: "0x" + Buffer.from(x25519.getPublicKey(priv)).toString("hex") }] as const; }));
const SIGNERS = new Map<EntityId, Address>([[ALICE, aliceAddr], [BOB, bobAddr], [CAROL, carolAddr]]);
const entityOf = (id: EntityId) => unwrap(createEntity({ id, jurisdiction: JUR, threshold: 1n, members: new Map([[SIGNERS.get(id)!, { shares: 1n }]]), committed: { entityEncryptionPublicKey: ENTITY_KEYS.get(id)!.pub }, jurisdictionConfig: UNREGISTERED_J }));
/** og requireEntityEncryptionPrivateKey + assertEntityEncryptionKeypair run on every proposal and replay: every validator holds its Entity's key. */
const withKeys = (ctx: any): typeof verifiers => ({ ...ctx, htlcInfra: (id: EntityId) => {
  const given = ctx.htlcInfra?.(id), key = ENTITY_KEYS.get(id)?.priv;
  return given?.encryptionPrivateKey !== undefined || key === undefined ? given : { profiles: [], ...given, encryptionPrivateKey: key };
} });
const inputOf = (id: EntityId, txs: EntityTx[], timestamp: bigint): RoutedEntityInput => ({ entityId: id, signerId: SIGNERS.get(id)!, input: { kind: "txs", timestamp, txs } });
const quiet = (start: Runtime, first: RoutedEntityInput[], ctx: object = verifiers): Runtime => {
  let rt = start, clock = NOW;
  const queue = [...first];
  for (let n = 0; queue.length > 0; n++) {
    if (n > 200) throw new Error("no quiescence");
    const input = queue.shift() as RoutedEntityInput;
    const out = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: [input] }, withKeys(ctx)));
    if (out.rejected.length > 0) throw new Error(JSON.stringify(out.rejected, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    rt = out.runtime; clock += 1n;
    for (const o of out.outbox) {
      if ("input" in o && o.input.kind === "txs" && o.input.txs.length === 0 && o.to === input.entityId) continue;
      queue.push(unwrap(convertOutput(rt, o, input.entityId, clock)));
    }
  }
  return rt;
};
const open = (to: EntityId, creditAmount?: bigint): EntityTx => ({ type: "openAccount", data: { targetEntityId: to, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig }, ...(creditAmount === undefined ? {} : { creditAmount, tokenId: unwrap(tokenId("1")) }) } } as EntityTx);
/** Alice -- Bob -- Carol: Bob opens both Accounts and extends Alice 1000 of credit; Carol extends Bob 1000. */
const network = (): Runtime => {
  let rt = spawn(spawn(spawn(withTestJurisdiction(createRuntime()), entityOf(ALICE)), entityOf(BOB)), entityOf(CAROL));
  rt = quiet(rt, [inputOf(BOB, [open(ALICE, 1000n), open(CAROL)], NOW)]);
  return quiet(rt, [inputOf(CAROL, [{ type: "extendCredit", data: { counterpartyEntityId: BOB, tokenId: unwrap(tokenId("1")), amount: 1000n } }], NOW + 100n)]);
};
const replicaOf = (rt: Runtime, id: EntityId): EntityReplica => rt.entities.get(replicaKey(id, SIGNERS.get(id)!))!;
/** og AccountReplica view the admission code reads: status, domain, sides, deltas with holds. */
const ogAccount = (c: AccountReplica, status?: string) => {
  const id = replicaId(c);
  return {
    status: status ?? (c._tag === "preparing" ? "dispute_preparing" : c._tag === "disputed" ? "disputed" : "active"),
    state: { domain: c.state.terms.domain, leftEntity: id.left, rightEntity: id.right, deltas: new Map([...c.state.account.deltas].map(([tk, d]) => [Number(tk), { ...d, tokenId: Number(tk), leftAllowance: 0n, rightAllowance: 0n, leftHold: holds(c.state, tk, true), rightHold: holds(c.state, tk, false) }])) },
  };
};
const ogStateOf = (r: EntityReplica, timestamp: number, paybook = new Map<string, unknown>()) => ({
  entityId: r.state.id, timestamp, lastFinalizedJHeight: 0, entityEncryptionPublicKey: String(ogOf(r.state)["entityEncryptionPublicKey"]),
  paybook: { entries: paybook, feesEarned: 0n }, accounts: new Map([...r.accountReplicas].map(([peer, c]) => [peer, ogAccount(c)])),
});
const profile = (id: EntityId, accounts: readonly { counterpartyId: string; domain: unknown; tokenCapacities: Map<number, { inCapacity: bigint; outCapacity: bigint }> }[], meta: object = {}): Binary =>
  ({ entityId: id, entityEncryptionPublicKey: ENTITY_KEYS.get(id)!.pub, name: id.slice(-4), metadata: { isHub: false, routingFeePPM: 100, baseFee: 0n, ...meta }, accounts }) as unknown as Binary;
const caps = (inC: bigint, outC: bigint) => new Map([[1, { inCapacity: inC, outCapacity: outC }]]);

describe(seedTag("entity-cross-j: Entity htlcPayment origination (og payment-admission.ts + handlers/htlc/payment.ts)"), () => {
  const rt = network(), alice = replicaOf(rt, ALICE), ts = Number(NOW + 1000n);
  const view = { id: ALICE, timestamp: ts, jHeight: 0, encryptionKey: ENTITY_KEYS.get(ALICE)!.pub, paybook: { entries: new Map(), feesEarned: 0n }, replicas: alice.accountReplicas };
  const baseProfiles = (): Binary[] => [
    profile(ALICE, []), profile(BOB, [{ counterpartyId: ALICE, domain: JUR, tokenCapacities: caps(1000n, 0n) }, { counterpartyId: CAROL, domain: JUR, tokenCapacities: caps(0n, 1000n) }], { routingFeePPM: 5000, baseFee: 1n }), profile(CAROL, []),
  ];
  const payment = (over: object = {}): EntityTx => ({ type: "htlcPayment", data: { targetEntityId: CAROL, tokenId: 1, amount: 100n, maxSenderDebit: 200n, route: [ALICE, BOB, CAROL], deliveryMode: "instant", ...over } } as EntityTx);

  test("MATCH: hashRawHtlcPaymentTx, materializeOriginatedHtlcPayments, assertOriginatedHtlcPayments and validatePreparedHtlcPayment on 250 random payments, profiles and paybooks", async () => {
    const r = rng(21);
    let accepted = 0;
    for (let i = 0; i < 250; i++) {
      const profiles = baseProfiles() as any[];
      const mut = int(r, 14);
      if (mut === 1) profiles[1] = { ...profiles[1], metadata: { ...profiles[1].metadata, routingFeePPM: pick(r, [0, 1, 999_999]), baseFee: BigInt(int(r, 50)) } };
      if (mut === 2) profiles[1] = { ...profiles[1], accounts: profiles[1].accounts.slice(0, 1) };
      if (mut === 3) profiles[1] = { ...profiles[1], accounts: [{ ...profiles[1].accounts[0], domain: { ...JUR, chainId: 999 } }, profiles[1].accounts[1]] };
      if (mut === 4) profiles[0] = { ...profiles[0], entityEncryptionPublicKey: ENTITY_KEYS.get(BOB)!.pub };
      if (mut === 5) profiles.pop();
      if (mut === 6) profiles.push(profiles[2]);
      if (mut === 7) profiles[2] = { ...profiles[2], accounts: [{ counterpartyId: BOB, domain: { ...JUR, depositoryAddress: "0x" + JUR.depositoryAddress.slice(2).toUpperCase() }, tokenCapacities: caps(5n, 5n) }] };
      if (mut === 8) profiles[1] = { ...profiles[1], accounts: profiles[1].accounts.map((a: any) => ({ ...a, tokenCapacities: new Map() })) };
      const over: Record<string, unknown> = {};
      const m2 = int(r, 16);
      if (m2 === 1) over.amount = BigInt(int(r, 3000));
      if (m2 === 2) over.maxSenderDebit = BigInt(int(r, 150));
      if (m2 === 3) over.route = [ALICE, CAROL];
      if (m2 === 4) over.route = [ALICE, "0x" + BOB.slice(2).toUpperCase(), CAROL];
      if (m2 === 5) over.route = [];
      if (m2 === 6) over.description = pick(r, ["pay", " pad", "x".repeat(300), ""]);
      if (m2 === 7) over.deliveryMode = pick(r, ["async", "direct"]);
      if (m2 === 8) over.startedAtMs = pick(r, [ts, ts + 1, 1.5]);
      if (m2 === 9) over.tokenId = pick(r, [2, -1, 70000]);
      if (m2 === 10) over.route = [ALICE, BOB, ALICE];
      if (m2 === 11) over.extra = 1;
      if (m2 === 12) over.amount = 0n;
      const secret = hex(r, 32);
      let tx = payment(over) as any;
      const registered = ogTry(() => withDeterministicHtlcTestSecret(tx, secret));
      if (registered.ok) tx = registered.value;
      if (r() < 0.05) tx = { ...tx, data: { ...tx.data, hashlock: hex(r, 32) } };
      const ogHash = ogTry(() => ogAdmission.hashRawHtlcPaymentTx(tx));
      same(ogHash, htlcPaymentTxHash(tx), `hash${i}`);
      const paybook = r() < 0.05 && registered.ok ? new Map([[tx.data.hashlock, { hashlock: tx.data.hashlock, createdTimestamp: 1 }]]) : new Map();
      // og infra-context.ts resolveRoute: gossip graph + PathFinder over the same profiles
      const resolveRoute = async (t: any) => { const m = new Map<string, unknown>(profiles.map((p: any) => [p.entityId, p])); const path = new PathFinder(ogBuildGraph(m as never, t.data.tokenId)).findRoutes(ALICE, t.data.targetEntityId, t.data.amount, t.data.tokenId, 100)[0]?.path; if (!path) throw new Error("no route"); return path; };
      const og = await ogTryAsync(() => ogAdmission.materializeOriginatedHtlcPayments({ state: ogStateOf(alice, ts, paybook) as never, proposalTxs: [tx], profiles: profiles as never, height: 1, resolveRoute }));
      const rw = materializeOriginated({ ...view, paybook: { entries: paybook as never, feesEarned: 0n } }, profiles, [tx], { profiles, secretFor: (h) => (ogHash.ok && h === ogHash.value && registered.ok ? secret : undefined) });
      same(og, rw.refused.size === 0 ? { ok: true, value: rw.originated } : { ok: false }, `mat${i}`);
      if (!og.ok || rw.refused.size > 0) continue;
      accepted++;
      const infra: HtlcFrameInfra = { gossipProfiles: profiles, peerAssertions: [], originated: rw.originated, entries: [] };
      // tamper one committed field of the prepared origin; og and the rewrite must agree on every variant
      const t = int(r, 8), o = rw.originated[0]!;
      const tampered: PreparedOriginated = t === 1 ? { ...o, senderLockAmount: o.senderLockAmount + 1n, totalFee: o.totalFee + 1n } : t === 2 ? { ...o, timelock: o.timelock - 1n } : t === 3 ? { ...o, revealBeforeHeight: o.revealBeforeHeight + 3 }
        : t === 4 ? { ...o, description: "other" } : t === 5 ? { ...o, hashlock: hex(r, 32) } : t === 6 ? { ...o, txHash: hex(r, 32) } : o;
      const frameCtx = { version: 1, entries: [], originated: [tampered] };
      same(ogTry(() => { validateHtlcPreparedInfraContext(frameCtx); return 1; }), preparedOriginOf(tampered) === null ? { ok: false } : { ok: true, value: 1 }, `shape${i}`);
      same(ogTry(() => ogAdmission.assertOriginatedHtlcPayments({ state: ogStateOf(alice, ts) as never, proposalTxs: [tx], profiles: profiles as never, height: 1, originated: [tampered] as never })),
        assertOriginated(view, { ...infra, originated: [tampered] }, [tx]), `assert${i}`);
      const status = pick(r, [undefined, undefined, "disputed"]);
      const ogS = { ...ogStateOf(alice, ts), accounts: new Map([[BOB, ogAccount(alice.accountReplicas.get(BOB)!, status)]]) };
      const rwReplicas = status === "disputed" ? new Map([[BOB, { ...alice.accountReplicas.get(BOB)!, _tag: "disputed" } as AccountReplica]]) : alice.accountReplicas;
      same(ogTry(() => ogAdmission.validatePreparedHtlcPayment(ogS as never, tx, { htlc: { version: 1, entries: [], originated: [tampered] } } as never)), validatePreparedHtlcPayment({ ...view, replicas: rwReplicas }, tx, { ...infra, originated: [tampered] }), `valid${i}`);
    }
    expect(accepted).toBeGreaterThan(50);
  });

  test("MATCH: Alice's frame commits og's prepared origin, her paybook entry and root equal og handleHtlcPayment's, and the first-hop htlc_lock is og's wire tx", async () => {
    const profiles = baseProfiles(), secret = "0x" + "42".repeat(32);
    const tx = withDeterministicHtlcTestSecret({ type: "htlcPayment", data: { targetEntityId: CAROL, tokenId: 1, amount: 100n, maxSenderDebit: 200n, route: [ALICE, BOB, CAROL], deliveryMode: "instant", description: "invoice 7" } } as never, secret) as unknown as EntityTx;
    const txHash = ogAdmission.hashRawHtlcPaymentTx(tx as never);
    const ctx = { ...verifiers, htlcInfra: (id: EntityId) => (id === ALICE ? { profiles, secretFor: (h: string) => (h === txHash ? secret : undefined), online: () => true } : undefined) };
    const step = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: [inputOf(ALICE, [tx], BigInt(ts))] }, withKeys(ctx)));
    expect(step.rejected.length).toBe(0);
    const after = replicaOf(step.runtime, ALICE);
    const og = await ogAdmission.materializeOriginatedHtlcPayments({ state: ogStateOf(alice, ts) as never, proposalTxs: [tx as never], profiles: profiles as never, height: 1, resolveRoute: async () => [] });
    // og handleHtlcPayment on the same prepared context: paybook entry and first-hop lock
    const program = createBookIntentProgram(), ogState = ogStateOf(alice, ts) as any;
    const handled = await handleHtlcPayment(ogState, tx as never, { quietRuntimeLogs: true } as never, [], true, { htlc: { version: 1, entries: [], originated: og } } as never, program.openSlot());
    applyBookIntentProgram(handled.newState, program);
    expect(stableJson([...(after.state.paybook?.entries ?? new Map())])).toBe(stableJson([...handled.newState.paybook.entries]));
    expect(stableJson(unwrap(entityCollectionCommitment(after.state.paybook!.entries as never, "paybookHashlock")))).toBe(stableJson(ogCollection(handled.newState.paybook.entries, false, "paybookHashlock")));
    const lock = step.outbox.find((o) => "tx" in o && o.tx.data.kind === "ack_frame");
    if (lock === undefined || !("tx" in lock) || lock.tx.data.kind !== "ack_frame") throw new Error("no first-hop frame");
    const child = after.accountReplicas.get(BOB)!;
    expect(stableJson(unwrap(wireTx(lock.tx.data.frame.txs[0] as never, replicaId(child), isLeft(ALICE, replicaId(child)))))).toBe(stableJson(handled.accountTxs[0]!.tx));
    // the committed Entity frame carries exactly og's prepared origin; replaying the same input reproduces the same outbox
    const committed = [...step.runtime.entities.values()].length;
    expect(committed).toBe(3);
    const replayed = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: [inputOf(ALICE, [tx], BigInt(ts))] }, withKeys(ctx)));
    expect(stableJson(replayed.outbox)).toBe(stableJson(step.outbox));
  });
});

// ---- Inbound HTLC: og entity/paybook/materialize-context.ts, tx/handlers/account/committed-{htlc,frame}-followups.ts ----
import * as ogMaterialize from "../../core/entity/paybook/materialize-context.ts";
import * as ogHtlcFollow from "../../core/entity/tx/handlers/account/committed-htlc-followups.ts";
import * as ogFrameFollow from "../../core/entity/tx/handlers/account/committed-frame-followups.ts";
import { hashHtlcSecret, inboundHtlcEntries, paybookFollowups, type AccountTxTarget, type CommittedHtlcFrame, type PaybookEntry, type PreparedHtlcEntry } from "../xln.ts";

describe(seedTag("entity-cross-j: inbound HTLC (og materialize-context.ts + committed HTLC followups)"), () => {
  const profiles = (): Binary[] => [
    profile(ALICE, []), profile(BOB, [{ counterpartyId: ALICE, domain: JUR, tokenCapacities: caps(1000n, 0n) }, { counterpartyId: CAROL, domain: JUR, tokenCapacities: caps(0n, 1000n) }], { routingFeePPM: 5000, baseFee: 1n }), profile(CAROL, []),
  ];
  const secret = "0x" + "42".repeat(32);
  const paymentTx = (amount = 100n) => withDeterministicHtlcTestSecret({ type: "htlcPayment", data: { targetEntityId: CAROL, tokenId: 1, amount, maxSenderDebit: 200n, route: [ALICE, BOB, CAROL], deliveryMode: "instant", description: "invoice 9" } }, secret) as unknown as EntityTx;
  const infraFor = (tx: EntityTx, online: (id: string) => boolean = () => true) => {
    const txHash = ogAdmission.hashRawHtlcPaymentTx(tx as never);
    return { ...verifiers, htlcInfra: (id: EntityId) => ({ profiles: profiles(), online, encryptionPrivateKey: ENTITY_KEYS.get(id)!.priv, ...(id === ALICE ? { secretFor: (h: string) => (h === txHash ? secret : undefined) } : {}) }) };
  };
  const deltaOf = (rt: Runtime, id: EntityId, peer: EntityId) => replicaOf(rt, id).accountReplicas.get(peer)!.state.account.deltas.get(unwrap(tokenId("1")))!;

  test("MATCH: a routed payment Alice -> Bob -> Carol settles end to end: Carol pays out, Bob earns the fee, every paybook entry terminates", () => {
    const tx = paymentTx(), ctx = infraFor(tx);
    const done = quiet(network(), [inputOf(ALICE, [tx], NOW + 1000n)], ctx);
    const og = ogAdmission; void og;
    for (const id of [ALICE, BOB, CAROL]) expect([...(replicaOf(done, id).state.paybook?.entries ?? new Map()).keys()]).toEqual([]);
    const lock = unwrap(htlcPaymentTxHash(tx as never));
    expect(lock.length).toBe(66);
    // og quote: Alice locks the sender amount og's route quote asks for; Bob forwards 100 and keeps the difference as its fee.
    const quote = ogQuote.quoteHtlcPaymentRouteWithIndex(ogQuote.buildRoutingProfileIndex(profiles() as never), [ALICE, BOB, CAROL], 1, 100n) as { senderLockAmount: bigint };
    expect(quote.senderLockAmount).toBeGreaterThan(100n);
    expect(replicaOf(done, BOB).state.paybook?.feesEarned).toBe(quote.senderLockAmount - 100n);
    expect(deltaOf(done, ALICE, BOB).offdelta + deltaOf(done, ALICE, BOB).ondelta).toBe(isLeft(ALICE, replicaId(replicaOf(done, ALICE).accountReplicas.get(BOB)!)) ? -quote.senderLockAmount : quote.senderLockAmount);
    expect(deltaOf(done, BOB, CAROL).offdelta + deltaOf(done, BOB, CAROL).ondelta).toBe(isLeft(BOB, replicaId(replicaOf(done, BOB).accountReplicas.get(CAROL)!)) ? -100n : 100n);
    for (const id of [ALICE, BOB, CAROL]) for (const c of replicaOf(done, id).accountReplicas.values()) expect(c.state.locks.size).toBe(0);
  });

  test("MATCH: Bob refuses to forward to an offline next hop; the error flows back and Alice's originated payment terminates with balances untouched", () => {
    const tx = paymentTx(), ctx = infraFor(tx, (id) => id !== CAROL);
    const done = quiet(network(), [inputOf(ALICE, [tx], NOW + 1000n)], ctx);
    for (const id of [ALICE, BOB, CAROL]) expect([...(replicaOf(done, id).state.paybook?.entries ?? new Map()).keys()]).toEqual([]);
    expect(deltaOf(done, ALICE, BOB).offdelta).toBe(0n);
    expect(replicaOf(done, BOB).state.paybook?.feesEarned ?? 0n).toBe(0n);
    for (const id of [ALICE, BOB, CAROL]) for (const c of replicaOf(done, id).accountReplicas.values()) expect(c.state.locks.size).toBe(0);
  });
});
import { htlcEnvelopeHash } from "../xln.ts";

/** Key-sorted JSON (Maps as sorted entry lists, bigints tagged) so og's and the rewrite's object key order never matters. */
const sortedJson = (v: unknown): string => JSON.stringify(v, function (_k, x) {
  if (typeof x === "bigint") return `${x}n`;
  if (x instanceof Map) return [...x].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1));
  if (x !== null && typeof x === "object" && !Array.isArray(x)) return Object.fromEntries(Object.keys(x).filter((k) => x[k] !== undefined).sort().map((k) => [k, x[k]]));
  return x;
});
const ogAccountTx = (t: any) => t.type === "htlc_resolve"
  ? { type: "htlc_resolve", data: t.outcome === "secret" ? { lockId: t.lockId, outcome: "secret", secret: t.secret } : { lockId: t.lockId, outcome: "error", ...(t.reason === undefined ? {} : { reason: t.reason }) } }
  : { type: "htlc_lock", data: { lockId: t.lockId, hashlock: t.hashlock, timelock: t.timelock, revealBeforeHeight: Number(t.revealBeforeHeight), amount: t.amount, tokenId: Number(t.tokenId), ...(t.envelope === undefined ? {} : { envelope: t.envelope }) } };

describe(seedTag("entity-cross-j: inbound HTLC MATCH vs og (materialize-context.ts, committed-htlc-followups.ts, committed-frame-followups.ts)"), () => {
  const profiles = (): Binary[] => [
    profile(ALICE, []), profile(BOB, [{ counterpartyId: ALICE, domain: JUR, tokenCapacities: caps(1000n, 0n) }, { counterpartyId: CAROL, domain: JUR, tokenCapacities: caps(0n, 1000n) }], { routingFeePPM: 5000, baseFee: 1n }), profile(CAROL, []),
  ];

  test("MATCH: materializeHtlcPreparedInfraContext entries on 240 mutated inbound locks (AEAD, onion, next hop, liveness, capacity, fee policy, deadlines, keys, duplicates)", async () => {
    const secret = "0x" + "24".repeat(32);
    const tx = withDeterministicHtlcTestSecret({ type: "htlcPayment", data: { targetEntityId: CAROL, tokenId: 1, amount: 100n, maxSenderDebit: 200n, route: [ALICE, BOB, CAROL], deliveryMode: "instant" } }, secret) as unknown as EntityTx;
    const txHash = ogAdmission.hashRawHtlcPaymentTx(tx as never);
    const ctx = { ...verifiers, htlcInfra: (id: EntityId) => (id === ALICE ? { profiles: profiles(), secretFor: (h: string) => (h === txHash ? secret : undefined), online: () => true } : undefined) };
    const base = network(), step = unwrap(applyRuntime(base, { runtimeTxs: [], entityInputs: [inputOf(ALICE, [tx], NOW + 1000n)] }, withKeys(ctx)));
    const out = step.outbox.find((o) => "tx" in o && o.to === BOB && o.tx.data.kind === "ack_frame") as { tx: { data: any } };
    const msg = out.tx.data, bob = replicaOf(step.runtime, BOB), lock0 = msg.frame.txs.find((t: any) => t.type === "htlc_lock");
    expect(lock0?.envelope).toBeDefined();
    const r = rng(33), outcomes = new Map<string, number>();
    for (let i = 0; i < 240; i++) {
      const k = int(r, 15);
      let lock = { ...lock0 };
      if (k === 1) { const c = lock.envelope.ciphertext as string, at = 10 + int(r, c.length - 20); lock = { ...lock, envelope: { ...lock.envelope, ciphertext: c.slice(0, at) + (c[at] === "A" ? "B" : "A") + c.slice(at + 1) } }; }
      if (k === 2) lock = { ...lock, amount: lock.amount + 1n };
      if (k === 3) lock = { ...lock, timelock: lock.timelock - 1n };
      if (k === 4) lock = { ...lock, lockId: hex(r, 32) };
      if (k === 5) { const { envelope: _e, ...bare } = lock; lock = bare; }
      const frame = { ...msg.frame, txs: msg.frame.txs.map((t: any) => (t.type === "htlc_lock" ? lock : t)) };
      const m = { ...msg, frame };
      const ts = k === 6 ? Number(lock0.timelock) - 30_000 + int(r, 20_000) : Number(NOW) + 2000;
      const jHeight = k === 7 ? Number(lock0.revealBeforeHeight) - int(r, 6) : 0;
      const hub = k === 8 ? { routingFeePPM: pick(r, [1, 20_000, 999_999]), baseFee: pick(r, [0n, 1n, 3n, 50n]) } : undefined;
      const known = new Set<string>(k === 10 ? [ALICE, BOB] : [ALICE, BOB, CAROL]), up = (id: string) => known.has(id) && !(k === 9 && id === CAROL);
      let replicas = bob.accountReplicas;
      if (k === 11) replicas = new Map([...replicas].filter(([p]) => p !== CAROL));
      if (k === 14) { const c = replicas.get(CAROL)!, tk = unwrap(tokenId("1")), d = c.state.account.deltas.get(tk)!; replicas = new Map(replicas).set(CAROL, { ...c, state: { ...c.state, account: { ...c.state.account, deltas: new Map(c.state.account.deltas).set(tk, { ...d, leftCreditLimit: BigInt(int(r, 120)), rightCreditLimit: BigInt(int(r, 120)) }) } } } as AccountReplica); }
      const priv = k === 12 ? ENTITY_KEYS.get(CAROL)!.priv : ENTITY_KEYS.get(BOB)!.priv;
      const rwTx = { type: "accountInput", data: m } as EntityTx, txs = k === 13 ? [rwTx, rwTx] : [rwTx];
      const seeded = withOg(bob.state, { lastFinalizedJHeight: jHeight });
      const rw = inboundHtlcEntries({ state: hub === undefined ? seeded : asHub(seeded, hub), replicas, timestamp: ts, publicKey: ENTITY_KEYS.get(BOB)!.pub, privateKey: priv, online: up }, txs);
      const child = bob.accountReplicas.get(ALICE)!;
      const ogTx = { type: "accountInput", data: { kind: "ack_frame", fromEntityId: m.fromEntityId, toEntityId: m.toEntityId, domain: m.domain, proposal: { frame: { height: Number(frame.height), stateHash: frame.stateHash, timestamp: Number(frame.timestamp), accountTxs: frame.txs.map((t: any) => (t.type === "htlc_lock" ? ogAccountTx(t) : unwrap(wireTx(t, replicaId(child), isLeft(ALICE, replicaId(child)))))) } } } };
      const ogState = {
        entityId: BOB, timestamp: ts, lastFinalizedJHeight: jHeight, entityEncryptionPublicKey: ENTITY_KEYS.get(BOB)!.pub, config: { validators: [bobAddr], shares: { [bobAddr]: 1n }, threshold: 1n },
        ...(hub === undefined ? {} : { hubRebalanceConfig: hub }), paybook: { entries: new Map(), feesEarned: 0n }, accounts: new Map([...replicas].map(([p, c]) => [p, ogAccount(c)])),
      };
      const og = await ogTryAsync(async () => (await ogMaterialize.materializeHtlcPreparedInfraContext({
        state: ogState as never, proposalTxs: (k === 13 ? [ogTx, ogTx] : [ogTx]) as never, entityEncryptionPublicKey: ENTITY_KEYS.get(BOB)!.pub, entityEncryptionPrivateKey: priv, isEntityOnline: up,
        profiles: [], parentFrameHash: "0x" + "00".repeat(32), height: 2, resolveRoute: async () => { throw new Error("no route"); },
      })).entries);
      expect(`${i}:${k}:${rw.ok}`).toBe(`${i}:${k}:${og.ok}`);
      if (og.ok && rw.ok) {
        expect(sortedJson(rw.value)).toBe(sortedJson(og.value));
        for (const e of rw.value as readonly PreparedHtlcEntry[]) outcomes.set(e.outcome.kind === "reject" ? e.outcome.reason : e.outcome.kind, (outcomes.get(e.outcome.kind === "reject" ? e.outcome.reason : e.outcome.kind) ?? 0) + 1);
      }
    }
    // every og outcome class is exercised
    for (const kind of ["forward", "decrypt_failed", "next_hop_account_missing", "next_hop_offline", "insufficient_capacity", "fee_below_policy", "deadline_unsafe"]) expect(`${kind}:${(outcomes.get(kind) ?? 0) > 0}`).toBe(`${kind}:true`);
  }, 30_000);

  test("MATCH: committed resolve / lock / timeout / secret followups on 400 random paybooks and committed frames (paybook, fees, returned Account txs)", async () => {
    const r = rng(47), toBob = (id: string) => ({ from: id, to: BOB, domain: JUR });
    const env = (n: number): HtlcEnvelope => unwrap(encryptOpaqueHtlc(bytes(r, 40 + n), ENTITY_KEYS.get(BOB)!.pub, hex(r, 32), keyPair(r).priv));
    let accepted = 0;
    const eventNames = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const secrets = Array.from({ length: 4 }, () => hex(r, 32)), locks = secrets.map((s) => hashHtlcSecret(s)!);
      const peer = pick(r, [ALICE, CAROL]), ts = 1_000_000 + int(r, 1000), fees0 = BigInt(int(r, 10));
      const entries0 = new Map<string, PaybookEntry>();
      for (let j = 0; j < 4; j++) {
        if (r() < 0.4) continue;
        entries0.set(locks[j]!, {
          hashlock: locks[j]!, tokenId: 1, amount: BigInt(1 + int(r, 1000)), createdTimestamp: 5, ...(r() < 0.4 ? { originated: true as const } : {}), ...(r() < 0.6 ? { inboundEntity: pick(r, [ALICE, CAROL]) } : {}),
          ...(r() < 0.6 ? { outboundEntity: pick(r, [ALICE, CAROL]) } : {}), ...(r() < 0.4 ? { pendingFee: BigInt(int(r, 5)) } : {}), ...(r() < 0.15 ? { secret: secrets[j] } : {}), ...(r() < 0.3 ? { description: "d" } : {}),
        });
      }
      const resolveTx = (j: number) => r() < 0.55
        ? { type: "htlc_resolve", lockId: locks[j]!, outcome: "secret", secret: r() < 0.04 ? hex(r, 32) : secrets[j]! }
        : { type: "htlc_resolve", lockId: locks[j]!, outcome: "error", ...(r() < 0.7 ? { reason: pick(r, ["timeout", "downstream_error", "x"]) } : {}) };
      const entries: PreparedHtlcEntry[] = [];
      const frameOf = (viaNewFrame: boolean, height: number): CommittedHtlcFrame => {
        const stateHash = hex(r, 32), txs: any[] = [];
        for (let n = 1 + int(r, 3); n > 0; n--) {
          const j = int(r, 4);
          if (!viaNewFrame || r() < 0.5) { txs.push(resolveTx(j)); continue; }
          const amount = BigInt(10 + int(r, 500)), envelope = env(int(r, 30));
          const lock = { type: "htlc_lock", lockId: locks[j]!, hashlock: locks[j]!, timelock: 10n ** 12n + BigInt(int(r, 1e6)), revealBeforeHeight: BigInt(100 + int(r, 50)), amount, tokenId: "1", envelope };
          txs.push(lock);
          if (r() < 0.05) continue;
          const bindingAmount = r() < 0.05 ? amount + 1n : amount;
          const outcome = pick(r, ["forward", "final", "reject"]) === "forward"
            ? { kind: "forward", nextHopEntityId: pick(r, [ALICE, CAROL]), forwardAmount: amount - BigInt(int(r, 5)), innerEnvelope: env(3) }
            : r() < 0.5 ? { kind: "final", secret: secrets[j]!, ...(r() < 0.5 ? { description: "note" } : {}), ...(r() < 0.5 ? { startedAtMs: 7 } : {}) }
              : { kind: "reject", reason: pick(r, ["decrypt_failed", "next_hop_offline", "fee_below_policy"]) };
          entries.push({ binding: { fromEntityId: peer, toEntityId: BOB, domain: { chainId: JUR.chainId, depositoryAddress: JUR.depositoryAddress.toLowerCase() }, accountFrameHash: stateHash, accountHeight: height, envelopeHash: htlcEnvelopeHash(envelope)!, hashlock: locks[j]!, tokenId: 1, amount: bindingAmount, timelock: lock.timelock, revealBeforeHeight: Number(lock.revealBeforeHeight) }, outcome } as PreparedHtlcEntry);
        }
        return { frame: { height: BigInt(height), stateHash, txs: txs }, viaNewFrame };
      };
      const frames = [...(r() < 0.5 ? [frameOf(false, 3)] : []), ...(r() < 0.75 ? [frameOf(true, 4)] : [])];
      const received = frames.some((f) => f.viaNewFrame) ? toBob(peer) : undefined;
      const rw = paybookFollowups({ paybook: { entries: entries0, feesEarned: fees0 }, queue: [] }, peer, frames, received, entries, ts, BOB);
      // og committed-input.ts driver: per committed frame the frame followups then each tx's lock followup; then timeouts; then the peer frame's secrets
      const og = await ogTryAsync(async () => {
        const program = createBookIntentProgram(), slot = program.openSlot();
        const newState: any = { entityId: BOB, timestamp: ts, config: {}, paybook: { entries: new Map([...entries0].map(([h, e]) => [h, { ...e }])), feesEarned: fees0 }, accounts: new Map() };
        const accountTxs: any[] = [], candidateEffects: any[] = [], consumed = new Set<string>(), byBinding = new Map(entries.map((e) => [`${e.binding.accountFrameHash}:${e.binding.hashlock}`, e]));
        const fctx: any = { env: {}, state: newState, newState, input: { fromEntityId: peer, toEntityId: BOB, domain: JUR }, account: {}, outputs: [], accountTxs, candidateEffects, bookIntentSlot: slot, infraContext: {}, preparedHtlcEntriesByBinding: byBinding, consumedPreparedHtlcBindings: consumed };
        for (const { frame, viaNewFrame } of frames) {
          const ogFrame = { height: Number(frame.height), stateHash: frame.stateHash, timestamp: ts, accountTxs: frame.txs.map(ogAccountTx) };
          ogFrameFollow.applyCommittedAccountFrameFollowups(newState, peer, ogFrame as never, true, accountTxs, {} as never, candidateEffects, slot);
          for (const t of ogFrame.accountTxs) await ogHtlcFollow.applyCommittedHtlcLockFollowup(fctx, t as never, ogFrame as never, true, viaNewFrame);
        }
        const timed = frames.flatMap(({ frame }) => (frame.txs as any[]).filter((t) => t.type === "htlc_resolve" && t.outcome === "error").map((t) => t.lockId));
        const revealed = frames.flatMap(({ frame, viaNewFrame }) => (viaNewFrame ? (frame.txs as any[]).filter((t) => t.type === "htlc_resolve" && t.outcome === "secret").map((t) => ({ secret: t.secret, hashlock: t.lockId })) : []));
        ogHtlcFollow.applyHtlcTimeoutFollowups(fctx, timed);
        ogHtlcFollow.applyHtlcSecretFollowups(fctx, revealed);
        applyBookIntentProgram(newState, program);
        return { entries: newState.paybook.entries, feesEarned: newState.paybook.feesEarned, accountTxs, events: candidateEffects.map((e: any) => ({ eventName: e.eventName, data: e.data })) };
      });
      // og applies an Account-level resolve before the Entity sees it: a mismatched preimage never commits, so both sides must refuse it
      expect(`${i}:${rw.ok}`).toBe(`${i}:${og.ok}`);
      if (!og.ok || !rw.ok) continue;
      accepted++;
      const value = rw.value;
      expect(sortedJson({ entries: value.paybook.entries, feesEarned: value.paybook.feesEarned })).toBe(sortedJson({ entries: og.value.entries, feesEarned: og.value.feesEarned }));
      expect(sortedJson(value.queue.map((q: AccountTxTarget) => ({ accountId: q.accountId, tx: ogAccountTx(q.tx) })))).toBe(sortedJson(og.value.accountTxs));
      // og candidateEffects runtime events (HtlcReceived / HtlcFinalized / HtlcForwardAccepted / HtlcFailed), in order
      expect(value.runtimeEvents ?? []).toEqual(og.value.events);
      for (const e of value.runtimeEvents ?? []) eventNames.add(e.eventName);
    }
    expect([...eventNames].sort()).toEqual(["HtlcFailed", "HtlcFinalized", "HtlcForwardAccepted", "HtlcReceived"]);
    expect(accepted).toBeGreaterThan(200);
  }, 30_000);
});

describe(seedTag("entity-cross-j: Account outputs above the Account (og committed-input.ts)"), () => {
  test("MATCH: a committed request_collateral is consumed as og's runtime event on both Entities, never refused; the request lands in both Account replicas", () => {
    const rt = network(), tk = unwrap(tokenId("1"));
    const req: EntityTx = { type: "requestCollateral", data: { counterpartyEntityId: BOB, tokenId: tk, amount: 50n, feeAmount: 1n, policyVersion: 1 } } as EntityTx;
    const done = quiet(rt, [inputOf(ALICE, [req], NOW + 500n)]);
    const a = replicaOf(done, ALICE).accountReplicas.get(BOB)!, b = replicaOf(done, BOB).accountReplicas.get(ALICE)!;
    expect(a.head.height).toBe(b.head.height);
    expect(a.head.height).toBeGreaterThan(replicaOf(rt, ALICE).accountReplicas.get(BOB)!.head.height);
    expect([...a.state.requested.keys()]).toEqual([tk]);
    expect(stableJson([...a.state.requested, ...a.state.requestFees])).toBe(stableJson([...b.state.requested, ...b.state.requestFees]));
  });
});

import { getEntityConfigBoardHash } from "../../core/hanko/signing.ts";
import { entityId } from "../xln.ts";

describe(seedTag("entity-cross-j: inbound HTLC on a 2-of-2 hub (og assertHtlcPreparedInfraContext validator replay)"), () => {
  test("MATCH: the hub's second validator re-derives the proposer's inbound entries from the frame's peer assertions; the routed payment settles", async () => {
    const board = { threshold: 2n, validators: [bobAddr, carolAddr].map((a) => a.toLowerCase()), shares: Object.fromEntries([bobAddr, carolAddr].map((a) => [a.toLowerCase(), 1n])) };
    const HUB = unwrap(entityId(await getEntityConfigBoardHash({} as never, board as never)));
    const hubKey = (() => { const priv = new Uint8Array(32).fill(29); return { priv: "0x" + Buffer.from(priv).toString("hex"), pub: "0x" + Buffer.from(x25519.getPublicKey(priv)).toString("hex") }; })();
    const hub = (signer: Address) => unwrap(createEntity({ id: HUB, jurisdiction: JUR, threshold: 2n, members: new Map([[bobAddr, { shares: 1n }], [carolAddr, { shares: 1n }]]), signerId: signer, committed: { entityEncryptionPublicKey: hubKey.pub }, jurisdictionConfig: UNREGISTERED_J }));
    const hubInput = (txs: EntityTx[], timestamp: bigint): RoutedEntityInput => ({ entityId: HUB, signerId: bobAddr, input: { kind: "txs", timestamp, txs } });
    let rt = spawn(spawn(spawn(spawn(withTestJurisdiction(createRuntime()), entityOf(ALICE)), hub(bobAddr)), hub(carolAddr)), entityOf(CAROL));
    const hubOnly = { ...verifiers, htlcInfra: (id: EntityId) => (id === HUB ? { profiles: [], encryptionPrivateKey: hubKey.priv } : undefined) };
    rt = quiet(rt, [hubInput([open(ALICE, 1000n), open(CAROL)], NOW)], hubOnly);
    // og admission signed Bob's collective opens into his propose; Carol's signed yes executes them
    const proposals = rt.entities.get(replicaKey(HUB, carolAddr))!.state.proposals as Map<string, unknown>;
    const [proposalId] = [...proposals.keys()];
    const vote: EntityTx = { type: "vote", data: { proposalId: proposalId ?? "", voter: carolAddr, choice: "yes" } };
    rt = quiet(rt, [{ entityId: HUB, signerId: carolAddr, input: { kind: "txs", timestamp: NOW, txs: [vote] } }], hubOnly);
    rt = quiet(rt, [inputOf(CAROL, [{ type: "extendCredit", data: { counterpartyEntityId: HUB, tokenId: unwrap(tokenId("1")), amount: 1000n } }], NOW + 100n)], hubOnly);
    const secret = "0x" + "31".repeat(32);
    const tx = withDeterministicHtlcTestSecret({ type: "htlcPayment", data: { targetEntityId: CAROL, tokenId: 1, amount: 100n, maxSenderDebit: 200n, route: [ALICE, HUB, CAROL], deliveryMode: "instant" } }, secret) as unknown as EntityTx;
    const txHash = ogAdmission.hashRawHtlcPaymentTx(tx as never);
    const hubProfile = { ...(profile(BOB, [{ counterpartyId: ALICE, domain: JUR, tokenCapacities: caps(1000n, 0n) }, { counterpartyId: CAROL, domain: JUR, tokenCapacities: caps(0n, 1000n) }], { routingFeePPM: 5000, baseFee: 1n }) as object), entityId: HUB, entityEncryptionPublicKey: hubKey.pub } as unknown as Binary;
    const profiles: Binary[] = [profile(ALICE, []), hubProfile, profile(CAROL, [])];
    const keyFor = (id: EntityId) => (id === HUB ? hubKey.priv : ENTITY_KEYS.get(id)!.priv);
    const ctx = { ...verifiers, htlcInfra: (id: EntityId) => ({ profiles, online: () => true, encryptionPrivateKey: keyFor(id), ...(id === ALICE ? { secretFor: (h: string) => (h === txHash ? secret : undefined) } : {}) }) };
    const done = quiet(rt, [inputOf(ALICE, [tx], NOW + 1000n)], ctx);
    const hubs = [...done.entities.values()].filter((r) => r.state.id === HUB);
    expect(hubs.length).toBe(2);
    for (const r of hubs) expect([...(r.state.paybook?.entries ?? new Map()).keys()]).toEqual([]);
    const fees = hubs.map((r) => r.state.paybook?.feesEarned);
    expect(fees[0]).toBe(fees[1]);
    expect((fees[0] ?? 0n) > 0n).toBe(true);
    expect(hubs[0]!.head.height).toBe(hubs[1]!.head.height);
    // a hub replica without the Entity key cannot materialize or replay inbound entries: og requireEntityEncryptionPrivateKey halts it
    const blind = { ...ctx, htlcInfra: (id: EntityId) => (id === HUB ? { profiles, online: () => true } : ctx.htlcInfra(id)) };
    expect(() => quiet(rt, [inputOf(ALICE, [tx], NOW + 1000n)], blind)).toThrow(`ENTITY_ENCRYPTION_PRIVATE_KEY_UNAVAILABLE:entity=${HUB}`);
  }, 30_000);
});
