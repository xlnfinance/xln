// consensus-final: Entity/Account consensus, admission, boards, orderbook and wire shapes (final wave). Every test runs og (core/ at 566c850) live.
import { describe, expect, test } from "bun:test";
import { seedOf, seedTag, untilCovered } from "./seed.ts";
import { x25519 } from "@noble/curves/ed25519";
import { ethers } from "ethers";
import { assertEntityEncryptionKeypair } from "../../core/protocol/htlc/multi-recipient.ts";
import { requireEntityEncryptionPrivateKey } from "../../core/entity/auth/crypto.ts";
import { computeEntityProfileHash } from "../../core/entity/profile/profile-descriptor.ts";
import {
  findCounterpartyBoardActivationConflict as ogFindConflict, isSelfBoardAuthorityTransitionFrame as ogIsAuthorityFrame,
  selectProposableEntityTxs as ogSelect, withoutCounterpartyBoardActivationConflicts as ogWithoutConflicts,
} from "../../core/entity/consensus/proposal/policy.ts";
import { selectEntityTxsWithinJRangeBudget as ogJRangeBudget } from "../../core/jurisdiction/machine/range-budget.ts";
import { encodeBoard, hashBoard } from "../../core/entity/factory.ts";
import { createEntityFrameHashFromStateRoot } from "../../core/entity/consensus/frame.ts";
import {
  accountId as rwAccountId, applyEntityInput, entityFrameHash, counterpartyBoardActivationConflict, createEntity, entityId, entityProfileHash, foldTxs, genesisReplica, jRangeBudgetPrefix,
  applyRuntime, convertOutput, createRuntime, replicaKey, spawn, tokenId, type Runtime, type RoutedEntityInput,
  parseEvmTx, quorumBoardHash, selectProposable, selfAuthorityTransitionFrame, withoutCounterpartyBoardActivationConflicts,
  type Address, type EntityId, type EntityInput, type EntityTx,
} from "../xln.ts";
import { ALICE, BOB, CAROL, NOW, TERMS, UNREGISTERED_J, aliceAddr, bobAddr, carolAddr, signedTxs, unwrap, verifiers } from "../xln_run.ts";
import { ogOf } from "./og-state.ts";

const prng = (base: number) => { let seed = seedOf(base); return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const rng = prng(0xc0_f1a1);
const ri = (n: number) => Math.floor(rng() * n);
const pick = <X,>(xs: readonly X[]): X => xs[ri(xs.length)] as X;
const hex32 = (): string => "0x" + Array.from({ length: 32 }, () => ri(256).toString(16).padStart(2, "0")).join("");
const pubOf = (priv: string): string => "0x" + Buffer.from(x25519.getPublicKey(Buffer.from(priv.slice(2), "hex"))).toString("hex");
const ogRun = <T,>(f: () => T): { ok: true; value: T } | { ok: false; code: string } => { try { return { ok: true, value: f() }; } catch (e) { return { ok: false, code: (e as Error).message }; } };
const lazyEntity = (signer: Address): EntityId => unwrap(entityId(quorumBoardHash({ _tag: "teaching", threshold: 1n, members: new Map([[signer, { shares: 1n }]]) })));

describe(seedTag("consensus-final: the Entity encryption keypair on every frame (cross-j.md row 48)"), () => {
  test("MATCH (og requireEntityEncryptionPrivateKey + assertEntityEncryptionKeypair): 200 random frames with no HTLC tx -- a missing, wrong, or malformed key refuses the proposal with og's error", () => {
    const seen = new Map<string, number>();
    for (let i = 0; i < 200; i++) {
      const priv = hex32(), variant = pick(["ok", "ok", "missing", "wrong", "badPub", "zeroPriv", "shortPriv"] as const);
      const pub = variant === "badPub" ? "0x12" : pubOf(priv);
      const given = variant === "missing" ? undefined : variant === "wrong" ? hex32() : variant === "zeroPriv" ? `0x${"00".repeat(32)}` : variant === "shortPriv" ? "0x1234" : priv;
      const id = lazyEntity(aliceAddr);
      const r = unwrap(createEntity({ id, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]), committed: { entityEncryptionPublicKey: pub } }));
      // og: the key comes from the Runtime's key store (requireEntityEncryptionPrivateKey), then the pair is checked whatever the frame holds
      const og = ogRun(() => {
        const key = requireEntityEncryptionPrivateKey({ infrastructure: { entityEncryptionPrivateKeys: new Map(given === undefined ? [] : [[id, given]]) } } as never, id);
        assertEntityEncryptionKeypair(pub, key);
      });
      const chat: EntityTx = { type: "chat", data: { from: aliceAddr.toLowerCase(), message: `m${i}` } };
      const input: EntityInput = { kind: "txs", timestamp: 1n, txs: [chat] };
      const rw = applyEntityInput(r, input, { ...verifiers, self: id, signerId: aliceAddr, ...(given === undefined ? {} : { htlc: { profiles: [], encryptionPrivateKey: given } }) });
      expect([variant, rw.ok]).toEqual([variant, og.ok]);
      if (!og.ok && !rw.ok) expect((rw.error as { reason?: string }).reason).toBe(og.code);
      seen.set(`${variant}:${og.ok}`, (seen.get(`${variant}:${og.ok}`) ?? 0) + 1);
    }
    for (const k of ["ok:true", "missing:false", "wrong:false", "badPub:false", "zeroPriv:false", "shortPriv:false"]) expect(seen.get(k) ?? 0).toBeGreaterThan(0);
  }, 30_000);
});

describe(seedTag("consensus-final: the profile descriptor is re-certified by the frame (og entity/profile/profile-descriptor.ts)"), () => {
  test("MATCH (og computeEntityProfileHash): 150 random Entities with pinned and unpinned Accounts, hub configs, jurisdictions, and over 100 pinned rows", () => {
    const tiers = [0n, 999n, 1000n, 5_000n, 12_345n, 10n ** 18n] as const;
    for (let i = 0; i < 150; i++) {
      const id = hex32(), many = i % 25 === 0, count = many ? 101 + ri(6) : ri(6);
      const jc = pick([undefined, { name: "  Anvil ", entityProviderAddress: "0xAbCdEf0000000000000000000000000000000001" }, { name: "", entityProviderAddress: "0x" + "22".repeat(20) }]);
      const hub = pick([undefined, { routingFeePPM: ri(500), baseFee: BigInt(ri(9)), policyVersion: 1, rebalanceLiquidityFeeBps: BigInt(ri(50)), rebalanceGasFee: 7n, hubName: pick(["", "H1"]), ...(rng() < 0.5 ? { swapTakerFeeBps: ri(30), rebalanceBaseFee: 3n, rebalanceTimeoutMs: 60_000 } : {}) }]);
      const profile = { name: pick(["", " Hub A ", "b"]), isHub: hub !== undefined, avatar: pick(["", "a.png"]), bio: "", website: pick(["", "https://x"]), ...(rng() < 0.3 ? { entityKind: "company", ...(rng() < 0.5 ? {} : { sectors: ["finance"] }) } : {}) };
      const key = pick([undefined, pubOf(hex32())]);
      const replicas = new Map<string, unknown>(), ogAccounts = new Map<string, unknown>();
      for (let a = 0; a < count; a++) {
        const peer = hex32(), aid = unwrap(rwAccountId(id as EntityId, peer as EntityId)), pinned = many || rng() < 0.7;
        const deltas = new Map<number, Record<string, bigint | number>>();
        for (let t = 0, n = ri(4); t < n; t++) {
          const tk = pick([1, 2, 3, 10, 7]);
          deltas.set(tk, { tokenId: tk, collateral: pick(tiers), ondelta: pick(tiers) - pick(tiers), offdelta: pick(tiers) - pick(tiers), leftCreditLimit: pick(tiers), rightCreditLimit: pick(tiers) });
        }
        const g = unwrap(genesisReplica(aid, TERMS)) as unknown as { state: { account: { deltas: unknown } } };
        replicas.set(peer, { ...g, state: { ...g.state, account: { ...g.state.account, deltas } }, ...(pinned ? { publicPinned: true } : {}) });
        ogAccounts.set(peer, { ...(pinned ? { publicPinned: true } : {}), state: { leftEntity: aid.left, rightEntity: aid.right, domain: TERMS.domain,
          deltas: new Map([...deltas].map(([tk, d]) => [tk, { ...d, leftAllowance: 0n, rightAllowance: 0n, leftHold: 0n, rightHold: 0n }])) } });
      }
      const r = unwrap(createEntity({ id: id as EntityId, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]), ...(jc === undefined ? {} : { jurisdictionConfig: jc }),
        committed: { profile, ...(hub === undefined ? {} : { hubRebalanceConfig: hub }), ...(key === undefined ? {} : { entityEncryptionPublicKey: key }) } }));
      const og = computeEntityProfileHash({ entityId: id, entityEncryptionPublicKey: key ?? "", profile, hubRebalanceConfig: hub, accounts: ogAccounts,
        config: { jurisdiction: jc === undefined ? undefined : { chainId: TERMS.domain.chainId, depositoryAddress: TERMS.domain.depositoryAddress, ...jc } } } as never);
      expect([i, unwrap(entityProfileHash(r.state, replicas as never))]).toEqual([i, og]);
    }
  });
  test("MATCH (og appendFinalProfileHash / buildChangedEntityProfileHashToSign): the genesis frame always signs the profile hash; later frames only when the descriptor changed", () => {
    const id = lazyEntity(aliceAddr), ctx = { verify: verifiers.verify, timestamp: 5n };
    const r = unwrap(createEntity({ id, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]), committed: { profile: { name: "A", isHub: false, avatar: "", bio: "", website: "" } } }));
    const ogHashOf = (profile: unknown): string => computeEntityProfileHash({ entityId: id, entityEncryptionPublicKey: "", profile, accounts: new Map(), config: {} } as never);
    const chat = (n: number): EntityTx => ({ type: "chat", data: { from: aliceAddr.toLowerCase(), message: `m${n}` } });
    // og: the frame carries Alice's local txs as her signed Entity commands
    const profilesOf = (s: typeof r.state, txs: readonly EntityTx[]) => { const f = unwrap(foldTxs(s, new Map(), signedTxs(s, aliceAddr, txs), ctx)); return { state: f.draft.state, profiles: (f.draft.hashes ?? []).filter((h) => h.type === "profile") }; };
    const genesis = profilesOf(r.state, [chat(0)]);
    const h0 = ogHashOf({ name: "A", isHub: false, avatar: "", bio: "", website: "" });
    expect(genesis.profiles).toEqual([{ hash: h0, type: "profile", context: `profile:${h0}` }]);
    const later = { ...genesis.state, height: 1n };
    expect(profilesOf(later, [chat(1)]).profiles).toEqual([]);
    const renamed = profilesOf(later, [{ type: "profile-update", data: { profile: { entityId: id, name: " B ", bio: "hi" } } } as EntityTx]);
    const h1 = ogHashOf(ogOf(renamed.state)["profile"]);
    expect(h1).not.toBe(h0);
    expect(renamed.profiles).toEqual([{ hash: h1, type: "profile", context: `profile:${h1}` }]);
  });
});

describe(seedTag("consensus-final: ethers v6 Transaction.from for blob (type 3) and set-code (type 4) transactions (entity-j.md EJ-R4)"), () => {
  const erng = prng(0x3_4e_4);
  const eri = (n: number) => Math.floor(erng() * n);
  const epick = <X,>(xs: readonly X[]): X => xs[eri(xs.length)] as X;
  const ehex = (bytes: number): string => `0x${Array.from({ length: bytes * 2 }, () => "0123456789abcdef"[eri(16)]).join("")}`;
  const wallets = [1, 2].map((i) => new ethers.Wallet(`0x${String(i).padStart(2, "0").repeat(32)}`));
  const versioned = (): string => `0x01${ehex(31).slice(2)}`;
  /** A random signed type 3 (bare, EIP-4844 sidecar or EIP-7594 sidecar) or type 4 transaction, serialized by ethers. */
  const signed = (): string => {
    const type = epick([3, 3, 4, 4]);
    const tx = ethers.Transaction.from({
      type, chainId: epick([1n, 31337n, 8453n]), nonce: epick([0, 1, 300, 70_000]), gasLimit: 21_000n + BigInt(eri(500_000)), to: epick([ehex(20), ehex(20)]),
      value: epick([0n, 1n, 10n ** 18n]), data: epick(["0x", ehex(4 + eri(40))]), maxPriorityFeePerGas: BigInt(eri(3)) * 1_000_000_000n, maxFeePerGas: 3_000_000_000n + BigInt(eri(1000)),
      ...(eri(3) === 0 ? { accessList: [{ address: ehex(20), storageKeys: Array.from({ length: eri(3) }, () => ehex(32)) }] } : {}),
      ...(type === 3 ? { maxFeePerBlobGas: BigInt(eri(1_000_000)), blobVersionedHashes: Array.from({ length: 1 + eri(3) }, versioned) } : {}),
      ...(type === 4 ? { authorizationList: Array.from({ length: eri(3) }, () => ({ address: ehex(20), nonce: BigInt(eri(1000)), chainId: epick([0n, 1n, 31337n]), signature: epick(wallets).signingKey.sign(ehex(32)) })) } : {}),
    });
    if (type === 3 && eri(2) === 0) {
      const eip7594 = eri(2) === 0, n = 1 + eri(2);
      if (eip7594) tx.blobWrapperVersion = 1;
      tx.blobs = Array.from({ length: n }, () => ({ data: ehex(1 + eri(64)), commitment: ehex(48), proof: eip7594 ? ehex(128 * 2) : ehex(48) }));
    }
    tx.signature = epick(wallets).signingKey.sign(tx.unsignedHash);
    return tx.serialized;
  };
  type F = string | F[];
  const be = (n: bigint): string => (n === 0n ? "0x" : ethers.toBeHex(n));
  const arr = (x: F | undefined): F[] => (Array.isArray(x) ? x : []);
  const big = (h: F | undefined): bigint => (typeof h !== "string" || h === "0x" ? 0n : BigInt(h));
  /** One structural mutation of a type 3/4 transaction: its fields, its sidecar, its authorizations, or its raw bytes. */
  const mutate = (raw: string): string => {
    const bytes = ethers.getBytes(raw);
    const flip = (): string => { const b = new Uint8Array(bytes), i = eri(b.length); b[i] = (b[i] ?? 0) ^ (1 << eri(8)); return ethers.hexlify(b); };
    let decoded: F;
    try { decoded = ethers.decodeRlp(bytes.slice(1)) as F; } catch { return flip(); }
    if (!Array.isArray(decoded)) return flip();
    const wrapped = Array.isArray(decoded[0]), outer = decoded as F[], fields = [...(wrapped ? (outer[0] as F[]) : outer)];
    const encode = (fs: F[], wrap: F[] | null = wrapped ? [...outer] : null): string => ethers.concat([bytes.slice(0, 1), ethers.encodeRlp((wrap === null ? fs : [fs, ...wrap.slice(1)]))]);
    const set = (i: number, v: F): string => { const fs = [...fields]; fs[i] = v; return encode(fs); };
    const type = bytes[0], sig = fields.length - 3, auths = type === 4 && Array.isArray(fields[9]) && Array.isArray((fields[9] as F[])[0]) ? (fields[9] as F[]) : [];
    const setAuth = (j: number, v: F): string => { const a = [...auths], row = [...(a[0] as F[])]; row[j] = v; a[0] = row; return set(9, a); };
    switch (eri(22)) {
      case 0: return flip();
      case 1: return ethers.hexlify(bytes.slice(0, Math.max(1, bytes.length - 1 - eri(4))));
      case 2: return set(5, "0x");
      case 3: return set(5, epick([ehex(19), ehex(21)]));
      case 4: return type === 3 ? set(10, [...arr(fields[10]), epick([ehex(31), ehex(33), [ehex(32)]])]) : set(9, epick(["0x", [[ehex(20)]], [["0x01", ehex(20), "0x", "0x", "0x01", "0x01", "0x"]]]));
      case 5: return type === 3 ? set(10, epick(["0x", ehex(32)])) : auths.length > 0 ? setAuth(1, epick(["0x", ehex(19), [ehex(20)]])) : set(9, [["0x01", ehex(20), "0x", "0x", ehex(32), ehex(32)]]);
      case 6: return type === 3 ? set(9, epick([ehex(33), "0x00", "0x0001"])) : auths.length > 0 ? setAuth(3, epick(["0x02", "0x", "0x01", "0x0001"])) : encode(fields);
      case 7: return auths.length > 0 ? setAuth(5, be(big((auths[0] as F[])[5]) | (1n << 255n))) : set(sig + 2, be(big(fields[sig + 2]) | (1n << 255n)));
      case 8: return auths.length > 0 ? setAuth(4, epick(["0x", ehex(33), `0x00${ehex(32).slice(2)}`])) : encode(fields);
      case 9: return set(sig, epick(["0x02", "0x00", "0x01", "0x", "0x0001"]));
      case 10: return set(sig + 1, epick(["0x", ehex(33)]));
      case 11: return set(sig + 2, "0x");
      case 12: { const fs = [...fields]; fs[2] = be(big(fields[3]) + 1n); return encode(fs); }
      case 13: return encode(fields.slice(0, sig));
      case 14: return encode(eri(2) === 0 ? [...fields, "0x"] : fields.slice(0, -1));
      case 15: return set(8, epick([[[ehex(20), [ehex(31)]]], [[ehex(19), []]], [ehex(20)]]));
      case 16: if (wrapped) { const w = [...outer]; w[1] = epick(["0x02", "0x", "0x0001", [ehex(1)]]); return encode(fields, w); } return encode(fields, [fields, [ehex(4)], [ehex(48)], [ehex(48)]]);
      case 17: if (wrapped) { const w = [...outer], k = 1 + eri(w.length - 1); w[k] = epick([[], [...arr(w[k]), ehex(48)], "0x"]); return encode(fields, w); } return encode(fields, [fields, "0x01", [ehex(4)], [ehex(48)], Array.from({ length: 128 }, () => ehex(2))]);
      case 18: if (wrapped) { const w = [...outer], k = w.length - 3; w[k] = [[ehex(2)]]; return encode(fields, w); } return set(1, `0x00${fields[1] === "0x" ? "" : (fields[1] as string).slice(2)}`);
      case 19: return ethers.concat([epick(["0x03", "0x04"]), bytes.slice(1)]);
      case 20: return set(0, "0x");
      default: return set(7, [fields[7] as F]);
    }
  };
  const ethersView = (raw: string): unknown => {
    try {
      const t = ethers.Transaction.from(raw), hash = t.hash;
      let from: string | null;
      try { from = t.from?.toLowerCase() ?? null; } catch { from = "ERR"; }
      return { type: t.type, hash, from, chainId: t.chainId, nonce: t.nonce, to: t.to?.toLowerCase() ?? null, value: t.value, data: t.data.toLowerCase() };
    } catch { return "REFUSED"; }
  };
  const rewriteView = (raw: string): unknown => {
    const r = parseEvmTx(raw);
    if (!r.ok) return "REFUSED";
    const t = r.value;
    return { type: t.type, hash: t.hash, from: t.from === null ? null : t.from.ok ? t.from.value : "ERR", chainId: t.chainId, nonce: t.nonce, to: t.to, value: t.value, data: t.data };
  };
  test("MATCH (randomized): 1500 signed type 3 (bare, 4844 and 7594 sidecars) and type 4 transactions and their mutations -- same refusal, hash, sender, chain, nonce, to, value, data", () => {
    const seen = { accepted3: 0, accepted4: 0, sidecar: 0, refused: 0 };
    for (let i = 0; i < 1500; i++) {
      let raw = signed();
      if (ethers.decodeRlp(ethers.getBytes(raw).slice(1)).length < 6) seen.sidecar++;
      for (let m = eri(3); m > 0; m--) raw = mutate(raw);
      const og = ethersView(raw);
      expect([i, raw, rewriteView(raw)]).toEqual([i, raw, og]);
      if (og === "REFUSED") seen.refused++; else if ((og as { type: number }).type === 3) seen.accepted3++; else seen.accepted4++;
    }
    expect(seen.accepted3).toBeGreaterThan(150);
    expect(seen.accepted4).toBeGreaterThan(150);
    expect(seen.sidecar).toBeGreaterThan(150);
    expect(seen.refused).toBeGreaterThan(300);
  }, 120_000);
});

describe(seedTag("consensus-final: the proposal policy of og entity/consensus/proposal/policy.ts (entity-j.md EJ-R3)"), () => {
  const prng2 = prng(0x90_11c7);
  const pri = (n: number) => Math.floor(prng2() * n);
  const ppick = <X,>(xs: readonly X[]): X => xs[pri(xs.length)] as X;
  const pword = (): string => "0x" + Array.from({ length: 64 }, () => "0123456789abcdef"[pri(16)]).join("");
  const peers = [pword(), pword(), pword()];
  const accountInput = (from: string): any => ({ type: "accountInput", data: { kind: "ack", fromEntityId: ppick([from, from.toUpperCase().replace("0X", "0x")]), toEntityId: pword() } });
  const range = (events: readonly any[], pad = 0): any => ({ type: "j_event", data: { baseHeight: 0, scannedThroughHeight: 1, rangeHash: "0x" + "ab".repeat(32), blocks: [{ blockNumber: 1, events }], ...(pad > 0 ? { pad: "x".repeat(pad) } : {}) } });
  const activated = (entityId: string, previousBoardHash = pword(), newBoardHash = pword()) => ({ type: "BoardActivated", data: { entityId, previousBoardHash, newBoardHash, previousBoardValidUntil: pri(8) === 0 ? "0" : "100" } });
  const chat = (): any => ({ type: "chat", data: { from: aliceAddr.toLowerCase(), message: `m${pri(1000)}` } });
  const indices = (all: readonly unknown[], picked: readonly unknown[]): number[] => picked.map((tx) => all.indexOf(tx));

  test("MATCH (og findCounterpartyBoardActivationConflict + withoutCounterpartyBoardActivationConflicts): 400 random frames with nested runtimeOutput / entityCommand rows", () => {
    let conflicts = 0;
    for (let i = 0; i < 400; i++) {
      const self = pword(), txs: any[] = [];
      for (let k = 0, n = 1 + pri(6); k < n; k++) {
        const kind = pri(6), who = ppick([...peers, self]);
        const tx = kind === 0 ? range([activated(ppick([who, who.toUpperCase().replace("0X", "0x")])), { type: "ReserveUpdated", data: { entity: who } }]) : kind === 1 ? accountInput(who) : kind === 2 ? chat()
          : kind === 3 ? { type: "runtimeOutput", data: { entityTxs: [accountInput(who), chat()] } } : kind === 4 ? { type: "entityCommand", data: { txs: [range([activated(who)]), chat()] } } : { type: "runtimeOutput", data: { entityTxs: [{ type: "entityCommand", data: { txs: [accountInput(who)] } }] } };
        txs.push(tx);
      }
      const og = ogFindConflict(self, txs), mine = counterpartyBoardActivationConflict(self, txs as EntityTx[]);
      expect([i, mine]).toEqual([i, og]);
      if (og !== null) conflicts++;
      expect(indices(txs, withoutCounterpartyBoardActivationConflicts(self, txs as EntityTx[]))).toEqual(indices(txs, ogWithoutConflicts(self, txs)));
    }
    expect(conflicts).toBeGreaterThan(50);
  });

  test("MATCH (og selectProposableEntityTxs + isSelfBoardAuthorityTransitionFrame): 300 random mempools of self board ranges, handovers, Account rows and plain txs, on lazy and uncertified Entities", async () => {
    const seen = new Map<string, number>();
    const signers = [aliceAddr, "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc"].map((a) => a.toLowerCase());
    const wanted = ["SELF_BOARD_HANDOVER_PRIORITY", "SELF_BOARD_CONFIG_HANDOVER_REQUIRED", "SELF_BOARD_ROTATION_PRIORITY", "SELF_BOARD_ACTIVATION_REQUIRED", "SELF_BOARD_CERTIFICATION_REQUIRED", "COUNTERPARTY_BOARD_ACTIVATION_PRIORITY", "plain"];
    for (let i = 0, more = untilCovered(300, () => wanted.every((k) => (seen.get(k) ?? 0) > 0)); more(i); i++) {
      const members = new Map([[aliceAddr, { shares: 1n }]]), lazy = pri(3) > 0, board = quorumBoardHash({ _tag: "teaching", threshold: 1n, members });
      const id = lazy ? board : pword();
      const r = unwrap(createEntity({ id: unwrap(entityId(id)), jurisdiction: TERMS.domain, threshold: 1n, members }));
      const size = 1 + pri(2), newBoard = { mode: "proposer-based", threshold: 1n + BigInt(pri(size)), validators: signers.slice(0, size), shares: {} as Record<string, bigint> };
      for (const v of newBoard.validators) newBoard.shares[v] = 1n;
      const newHash = hashBoard(encodeBoard(newBoard as never)).toLowerCase();
      const mempool: any[] = [];
      for (let k = 0, n = pri(6); k < n; k++) {
        const kind = pri(9);
        mempool.push(kind === 0 ? range([activated(id, ppick([board, pword()]), ppick([newHash, board, pword()]))]) : kind === 1 ? range([{ type: "EntityRegistered", data: { entityId: id, entityNumber: "7", boardHash: ppick([board, pword()]) } }])
          : kind === 2 ? { type: "boardHandover", data: { board: ppick([newBoard, { ...newBoard, mode: "gossip-based" }]) } } : kind === 3 ? accountInput(ppick(peers)) : kind === 4 ? range([activated(ppick(peers))])
          : kind === 5 ? ppick([range([], 0), { type: "j_event", data: { baseHeight: 0, scannedThroughHeight: 1, blocks: [] } }]) : chat());
      }
      const ogState = { entityId: id, height: 0, config: { mode: "proposer-based", threshold: 1n, validators: [aliceAddr.toLowerCase()], shares: { [aliceAddr.toLowerCase()]: 1n } } };
      const env: any = { quietRuntimeLogs: true, infrastructure: {} };
      let og: any;
      try { og = await ogSelect(env, ogState as never, mempool as never); } catch (e) { og = { error: (e as Error).message }; }
      const mine = selectProposable(r.state, mempool as EntityTx[]);
      const view = (x: any) => ("error" in x ? x.error : { txs: indices(mempool, x.txs), ready: x.currentAuthorityReady });
      expect([i, mine.ok ? view(mine.value) : ((mine.error as { reason?: string }).reason ?? (mine.error as { code?: string }).code)]).toEqual([i, view(og)]);
      const key = "error" in og ? `error:${String(og.error).split(":")[0]}` : `${og.reason ?? "plain"}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      // og isSelfBoardAuthorityTransitionFrame over the same candidate frame
      let ogAuth: any;
      try { ogAuth = await ogIsAuthorityFrame(env, ogState as never, mempool as never); } catch (e) { ogAuth = (e as Error).message; }
      const mineAuth = selfAuthorityTransitionFrame(r.state, mempool as EntityTx[]);
      expect([i, mineAuth.ok ? mineAuth.value : (mineAuth.error as { reason?: string }).reason]).toEqual([i, ogAuth]);
    }
    for (const k of wanted) expect([k, (seen.get(k) ?? 0) > 0]).toEqual([k, true]);
  }, 30_000);

  test("MATCH (og selectEntityTxsWithinJRangeBudget): multi-MiB ranges -- the same prefix, the suffix waits, an unfittable range or bad span halts", () => {
    const MiB = 1024 * 1024;
    const cases: any[][] = [
      [range([], 3 * MiB), chat(), range([], 4 * MiB), chat(), range([], 4 * MiB), chat(), range([], 1)],
      [range([], 6 * MiB), range([], 6 * MiB), chat()],
      [chat(), range([], 11 * MiB), chat()],
      [range([], 1), { type: "j_event", data: { baseHeight: 5, scannedThroughHeight: 5, blocks: [] } }],
      [{ type: "j_event", data: { baseHeight: -1, scannedThroughHeight: 5, blocks: [] } }],
      [chat(), range([], 9 * MiB), chat(), chat()],
    ];
    for (const [i, txs] of cases.entries()) {
      let og: any;
      try { og = indices(txs, ogJRangeBudget(txs).txs); } catch (e) { og = (e as Error).message; }
      const mine = jRangeBudgetPrefix(txs as EntityTx[]);
      expect([i, mine.ok ? indices(txs, mine.value) : (mine.error as { reason?: string }).reason]).toEqual([i, og]);
    }
  });
});

describe(seedTag("consensus-final: the j_event frame-hash projection of og entity/consensus/frame.ts (canonicalJEventDataForFrameHash)"), () => {
  test("MATCH (og createEntityFrameHashFromStateRoot): 400 random J ranges -- mixed-case text, fractional heights, extra keys, raw events, missing rangeHash / blocks -- commit og's projection or refuse with og's code", () => {
    const g = prng(0x7e_4a54);
    const gi = (n: number) => Math.floor(g() * n);
    const gp = <X,>(xs: readonly X[]): X => xs[gi(xs.length)] as X;
    const word = (): string => "0x" + Array.from({ length: 64 }, () => "0123456789abcdefABCDEF"[gi(22)]).join("");
    const ctxOf = (id: string): any => ({ version: 1, proposerReplicaId: `${id}:${aliceAddr.toLowerCase()}`, entityId: id, proposerSignerId: aliceAddr.toLowerCase(), parentFrameHash: "genesis", height: 1, gossipProfiles: [], peerAssertions: [], htlc: { version: 1, entries: [], originated: [] } });
    const ev = (): any => gp([
      { type: "ReserveUpdated", data: { entity: word(), tokenId: gp([1, "2"]), newBalance: gp(["5", 7n, "0x10"]) }, blockNumber: gi(9), blockHash: word(), transactionHash: word(), logIndex: gi(4) },
      { type: "EntityRegistered", data: { entityId: word(), entityNumber: "7", boardHash: word() } },
      { type: "BoardActivated", data: { entityId: word(), previousBoardHash: word(), newBoardHash: word(), previousBoardValidUntil: gp(["100", "0"]) } },
    ]);
    let refused = 0;
    for (let i = 0; i < 400; i++) {
      const id = word().toLowerCase();
      const data: any = {
        from: gp([aliceAddr, aliceAddr.toLowerCase(), undefined]), jurisdictionRef: gp([" Anvil:31337 ", "x", undefined]), baseHeight: gp([0, 3, 2.7, "4"]), scannedThroughHeight: gp([5, 5.5, "9"]),
        tipBlockHash: gp([word(), undefined]), eventHistoryRoot: word(), signature: gp([word(), undefined]), observedAt: gp([12, 12.9, undefined]),
        blocks: gp([[{ blockNumber: gp([1, 1.5, "2"]), blockHash: word(), eventsHash: word(), events: Array.from({ length: gi(3) }, ev), disputeFinalizationEvidenceHash: gp([word(), undefined]), extra: 1 }], [], "nope", undefined]),
        ...(gi(6) === 0 ? {} : { rangeHash: word() }), ...(gi(3) === 0 ? { extraKey: "dropped" } : {}),
      };
      const txs: any[] = [{ type: "chat", data: { from: aliceAddr.toLowerCase(), message: "m" } }, { type: "j_event", data }];
      const root = "0x" + "11".repeat(32), auth = "0x" + "22".repeat(32);
      let og: string;
      try { og = createEntityFrameHashFromStateRoot("genesis", 1, 50, txs, [], id, root, auth, ctxOf(id)); } catch (e) { og = (e as Error).message.split(":")[0] as string; }
      const mine = entityFrameHash({ prevFrameHash: "genesis", height: 1, timestamp: 50, txs, events: [], entityId: id, stateRoot: root, authorityRoot: auth, entityContext: ctxOf(id) });
      const got = mine.ok ? mine.value : ((mine.error as { code?: string }).code ?? mine.error._tag).split(":")[0];
      expect([i, got]).toEqual([i, og]);
      if (!mine.ok) refused++;
    }
    expect(refused).toBeGreaterThan(40);
    expect(refused).toBeLessThan(300);
  });
});

describe(seedTag("consensus-final: a received Account frame commits at once (rebalance-refresh.md RR-12)"), () => {
  test("MATCH (og commits the peer's frame when it signs the ACK): 40 random credit / payment rounds between three Entities -- after every Runtime step no Account sits in 'received', and each ack_frame leaves the receiver's head at the frame height", () => {
    const g = prng(0x12_12);
    const gi = (n: number) => Math.floor(g() * n);
    const signers = new Map<EntityId, Address>([[ALICE, aliceAddr], [BOB, bobAddr], [CAROL, carolAddr]]);
    const party = (id: EntityId) => unwrap(createEntity({ id, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[signers.get(id) as Address, { shares: 1n }]]), jurisdictionConfig: UNREGISTERED_J }));
    const t1 = unwrap(tokenId("1"));
    let clock = NOW, received = 0;
    const noneReceived = (rt: Runtime): void => {
      for (const r of rt.entities.values()) for (const c of r.accountReplicas.values()) expect(c._tag).not.toBe("received");
    };
    const quiet = (start: Runtime, first: RoutedEntityInput[]): Runtime => {
      let rt = start;
      const queue = [...first];
      for (let n = 0; queue.length > 0; n++) {
        if (n > 300) throw new Error("no quiescence");
        const input = queue.shift() as RoutedEntityInput;
        const before = rt;
        const out = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: [input] }, verifiers));
        rt = out.runtime;
        noneReceived(rt);
        const i = input.input;
        if (i.kind === "txs") for (const tx of i.txs) if (tx.type === "accountInput" && tx.data.kind === "ack_frame" && tx.data.frame !== undefined) {
          received++;
          const key = replicaKey(input.entityId, signers.get(input.entityId) as Address), prior = before.entities.get(key)?.accountReplicas.get(tx.data.fromEntityId);
          const child = rt.entities.get(key)?.accountReplicas.get(tx.data.fromEntityId);
          // a proposer that wins the simultaneous-proposal tie keeps its own frame (og: the left side ignores the right's proposal)
          if (child !== undefined && out.rejected.length === 0 && prior?._tag !== "proposed") expect(child.head._tag === "installed" && child.head.height >= BigInt(tx.data.frame.height)).toBe(true);
        }
        clock += 1n;
        for (const o of out.outbox) {
          if ("input" in o && o.input.kind === "txs" && o.input.txs.length === 0 && o.to === input.entityId) continue;
          queue.push(unwrap(convertOutput(rt, o, input.entityId, clock)));
        }
      }
      return rt;
    };
    const create = (id: EntityId, txs: EntityTx[]): RoutedEntityInput => ({ entityId: id, signerId: signers.get(id) as Address, input: { kind: "txs", timestamp: (clock += 10n), txs } });
    const open = (to: EntityId): EntityTx => ({ type: "openAccount", data: { targetEntityId: to, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig }, creditAmount: 1000n, tokenId: t1 } } as EntityTx);
    let rt = spawn(spawn(spawn(createRuntime(), party(ALICE)), party(BOB)), party(CAROL));
    rt = quiet(rt, [create(BOB, [open(ALICE), open(CAROL)])]);
    rt = quiet(rt, [create(ALICE, [{ type: "extendCredit", data: { counterpartyEntityId: BOB, tokenId: t1, amount: 1000n } } as EntityTx]), create(CAROL, [{ type: "extendCredit", data: { counterpartyEntityId: BOB, tokenId: t1, amount: 1000n } } as EntityTx])]);
    const ids = [ALICE, BOB, CAROL];
    for (let round = 0; round < 40; round++) {
      const from = ids[gi(3)] as EntityId, to = from === BOB ? (gi(2) === 0 ? ALICE : CAROL) : BOB;
      const tx: EntityTx = { type: "directPayment", data: { targetEntityId: to, tokenId: t1, amount: BigInt(1 + gi(5)), route: [from, to], deliveryMode: "direct" } } as EntityTx;
      rt = quiet(rt, gi(3) === 0 ? [create(from, [tx]), create(to === BOB ? BOB : to, [{ ...tx, data: { ...(tx.data), targetEntityId: from, route: [to, from] } } as EntityTx])] : [create(from, [tx])]);
    }
    expect(received).toBeGreaterThan(40);
  }, 60_000);
});
