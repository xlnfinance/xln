// Coverage: og's refusal text for the cross-j Account txs (og handlers/settlement/pull.ts handleCrossPullClose and
// validateCrossPullCloseEvidence, handlers/swap/offer cross-j quantization and paired source pull) against the
// rewrite's accountTxFailure. The cross-j lockstep in cross-j.test compares only accept/reject; here every refusal must
// carry og's exact message and thrown-ness. Each close is corrupted on one proof field, its binary, or its sender.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import {
  accountTransitionView, beginAccountTransition, commitAccountTransition, discardAccountTransition,
} from "../../../core/account/state/candidate-overlay.ts";
import { PersistentAccountStateMap } from "../../../core/account/state/persistent-state-map.ts";
import { applyAccountTxMutation } from "../../../core/account/tx/mutation.ts";
import {
  deriveCrossJurisdictionPrivateSeed, withCanonicalCrossJurisdictionRouteHash,
} from "../../../core/extensions/cross-j/index.ts";
import {
  accountId, accountTerms, accountTxFailure, applyAccountBody, buildHashLadderProof, committed, crossPullBinding,
  entityId, genesisAccount, genesisAccountBody, prepareCrossRoute, revealHashLadder, stableJson, tokenId,
  type AccountBody, type AccountTxFailure, type CrossRoute, type FoldCtx, type WireAccountTx,
} from "../../xln.ts";
import { unwrap } from "../../xln_run.ts";

// ---- seeded randomness: SEEDX overrides the fixed seed, and every failure names the seed ----
const SEED = process.env["SEEDX"] ? Number(process.env["SEEDX"]) : 0xc105e;
const prng = (seed: number): (() => number) => {
  const state = { s: seed | 0 };
  return () => {
    state.s = (state.s + 0x6d2b79f5) | 0;
    const t1 = Math.imul(state.s ^ (state.s >>> 15), 1 | state.s);
    const t2 = (t1 + Math.imul(t1 ^ (t1 >>> 7), 61 | t1)) ^ t1;
    return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296;
  };
};
const rng = prng(SEED);
const ri = (n: number): number => Math.floor(rng() * n);
const pick = <X,>(xs: readonly X[]): X => xs[ri(xs.length)] as X;
/** og's typed shells are built from plain data; this is the one place a shell is given its og type. */
const asOg = <T,>(shell: unknown): T => shell as T;
const W = (b: string): string => `0x${b.repeat(32)}`;

// ---- one Account LEFT-RIGHT on stack HERE; each route has one leg here and the other on THERE ----
const LEFT = W("11");
const RIGHT = W("22");
const DEP = `0x${"ab".repeat(20)}`;
const HERE = `stack:1:${DEP}`;
const THERE = `stack:7:0x${"cd".repeat(20)}`;
const RUNTIME_SEED = W("5e");
const LOT = 10n ** 12n;
const MAX_FILL = 65_535;
const tk = (n: number | string) => unwrap(tokenId(String(n)));
const openAccount = (credit: bigint): AccountBody => {
  const terms = unwrap(accountTerms({
    domain: { chainId: 1, depositoryAddress: DEP }, watchSeed: W("44"),
    disputeConfig: { leftResponseSeconds: 1, rightResponseSeconds: 1 },
  }));
  const genesis = genesisAccountBody(genesisAccount(unwrap(accountId(unwrap(entityId(LEFT)), unwrap(entityId(RIGHT))))), terms);
  const limits = ["1", "2", "3"].flatMap((t) => [true, false].map((byLeft) => ({ t, byLeft })));
  return limits.reduce((body, { t, byLeft }) => unwrap(applyAccountBody(
    body, { type: "set_credit_limit", tokenId: tk(t), limit: credit }, { byLeft, nowMs: 1n, jHeight: 0n, accountHeight: 1n },
  )).state, genesis);
};

// ---- og side: a persistent og replica seeded from the rewrite's committed view, driven through og's overlay ----
type OgReplica = Parameters<typeof beginAccountTransition>[0];
type OgRun = { readonly ok: true; readonly root: string } | { readonly ok: false; readonly thrown: boolean; readonly message: string };
const OG_MAPS = ["deltas", "locks", "pulls", "swapOffers", "subcontracts", "lendingIntents", "requestedRebalance",
  "requestedRebalanceFeeState", "rebalanceFeePolicies"] as const;
type OgMapNs = Parameters<typeof PersistentAccountStateMap.fromEntries>[0];
type OgMapEntries = Parameters<typeof PersistentAccountStateMap.fromEntries>[1];
const persistent = (ns: string, m: ReadonlyMap<unknown, unknown> = new Map()) =>
  PersistentAccountStateMap.fromEntries(asOg<OgMapNs>(ns), asOg<OgMapEntries>(m));
const ogReplicaOf = (body: AccountBody): OgReplica => {
  const v = asOg<Record<string, unknown>>(unwrap(committed(body)).view);
  const maps = Object.fromEntries(OG_MAPS.map((n) => [n, persistent(n, asOg(v[n]))]));
  const state = {
    domain: v["domain"], leftEntity: v["leftEntity"], rightEntity: v["rightEntity"], watchSeed: v["watchSeed"],
    disputeConfig: v["disputeConfig"], jNonce: v["jNonce"], lastFinalizedJHeight: v["lastFinalizedJHeight"],
    leftPendingJClaims: v["leftPendingJClaims"], rightPendingJClaims: v["rightPendingJClaims"], ...maps,
  };
  const shadow = { rebalance: { policy: persistent("rebalanceShadowPolicy"), submittedAtByToken: persistent("rebalanceShadowSubmitted") } };
  return asOg<OgReplica>({
    state, status: "active", currentHeight: 0, proofHeader: { fromEntity: LEFT, toEntity: RIGHT, nextProofNonce: 1 },
    currentFrame: { stateHash: "" }, pendingWithdrawals: persistent("pendingWithdrawals"), shadow, mempool: [],
  });
};
/** og's wire tx: data under `data`, token ids as numbers. */
const toOg = (tx: WireAccountTx): Parameters<typeof applyAccountTxMutation>[1] => {
  const { type, ...data } = tx;
  const numeric = ["tokenId", "giveTokenId", "wantTokenId"].filter((k) => k in data);
  const tokens = Object.fromEntries(numeric.map((k) => [k, Number(asOg<Record<string, unknown>>(data)[k])]));
  return asOg({ type, data: { ...data, ...tokens } });
};
const ogApply = async (replica: { current: OgReplica }, tx: WireAccountTx, byLeft: boolean, ts: number, jh: number): Promise<OgRun> => {
  const overlay = beginAccountTransition(replica.current);
  const run = await applyAccountTxMutation(accountTransitionView(overlay), toOg(tx), byLeft, ts, jh, false, undefined, undefined, undefined, [])
    .then((r) => ({ r }), (e: unknown) => ({ thrownMessage: e instanceof Error ? e.message : String(e) }));
  if ("thrownMessage" in run) {
    discardAccountTransition(overlay);
    return { ok: false, thrown: true, message: run.thrownMessage };
  }
  if (!run.r.ok) {
    discardAccountTransition(overlay);
    return { ok: false, thrown: false, message: run.r.rejection.message };
  }
  const c = commitAccountTransition(overlay, "diff");
  replica.current = c.account;
  return { ok: true, root: c.accountStateRoot };
};

// ---- routes and their txs (cross-j.test restingRoute, lockTx, offerTx, closeTx) ----
type Route = { readonly route: CrossRoute; readonly seed: string };
const restingRoute = (makerIsLeft: boolean, targetHere: boolean): Route => {
  const maker = makerIsLeft ? LEFT : RIGHT;
  const hub = makerIsLeft ? RIGHT : LEFT;
  const base: CrossRoute = {
    orderId: `o-${ri(1e9)}`, makerEntityId: maker, hubEntityId: hub,
    source: { jurisdiction: targetHere ? THERE : HERE, entityId: maker, counterpartyEntityId: hub, tokenId: pick([1, 2]), amount: LOT * BigInt(1 + ri(9)) },
    target: { jurisdiction: targetHere ? HERE : THERE, entityId: hub, counterpartyEntityId: maker, tokenId: pick([1, 2, 3]), amount: LOT * BigInt(1 + ri(9)) },
    sourceDisputeConfig: { leftResponseSeconds: 60, rightResponseSeconds: 60 },
    targetDisputeConfig: { leftResponseSeconds: 60, rightResponseSeconds: 60 },
    status: "intent", createdAt: 1_000, updatedAt: 1_000,
  };
  const prepared = unwrap(prepareCrossRoute(base, { runtimeSeed: RUNTIME_SEED, now: 2_000 }));
  const route = asOg<CrossRoute>(withCanonicalCrossJurisdictionRouteHash(asOg({ ...prepared, status: "resting" })));
  return { route, seed: deriveCrossJurisdictionPrivateSeed(RUNTIME_SEED, asOg(route)) };
};
type Leg = "source" | "target";
const pullOf = (route: CrossRoute, leg: Leg) => {
  const pull = leg === "source" ? route.sourcePull : route.targetPull;
  if (pull === undefined) throw new Error("fixture: prepared route without its pulls");
  return pull;
};
const lockTx = (route: CrossRoute, leg: Leg): WireAccountTx => {
  const pull = pullOf(route, leg);
  return {
    type: "cross_pull_lock", pullId: pull.pullId, tokenId: tk(pull.tokenId), amount: pull.signedAmount,
    fullHash: pull.fullHash, partialRoot: pull.partialRoot, crossJurisdiction: unwrap(crossPullBinding(route, leg)),
    crossJurisdictionRoute: route,
  };
};
/** The maker's cross-j offer, one of its terms nudged off the route or the lot grid. */
const offerTx = (route: CrossRoute): WireAccountTx => {
  const give = route.source.amount;
  const want = route.target.amount;
  const nudge = pick(["none", "none", "give+1", "give-lot", "subLot", "want+lot", "decimals"] as const);
  const giveAmount = nudge === "give+1" ? give + 1n : nudge === "give-lot" ? give - LOT : nudge === "subLot" ? LOT - 1n : give;
  const wantAmount = nudge === "want+lot" ? want + LOT : want;
  return asOg<WireAccountTx>({
    type: "swap_offer", offerId: route.orderId, giveTokenId: tk(route.source.tokenId), giveTokenDecimals: nudge === "decimals" ? 6 : 18,
    giveAmount, wantTokenId: tk(route.target.tokenId), wantTokenDecimals: 18, wantAmount, maxFee: 0n,
    minNetReceive: wantAmount, crossJurisdiction: route,
  });
};
const chainShare = (total: bigint, ratio: number): bigint => (ratio >= MAX_FILL ? total : (total * BigInt(ratio)) / BigInt(MAX_FILL));
const closeMode = (ratio: number): string => (ratio >= MAX_FILL ? "full" : ratio === 0 ? "pure_cancel" : "partial_cancel_remainder");
const CORRUPTIONS = ["none", "none", "none", "ratioRange", "mode", "order", "routeHash", "pullSwap", "amount",
  "binaryHash", "nonHex", "garbage", "ratioOff", "missing"] as const;
type Corruption = (typeof CORRUPTIONS)[number];
/** A close of `leg` at `ratio`, corrupted as `c`: each corruption trips one of og's evidence checks in order. */
const closeTx = (route: CrossRoute, leg: Leg, seed: string, ratio: number, c: Corruption): WireAccountTx => {
  const binary = revealHashLadder(buildHashLadderProof(seed), ratio).binary;
  // ratioOff keeps the proof self-consistent at another ratio, so only the binary's own ratio disagrees
  const proofRatio = c === "ratioOff" ? (ratio + 1) % (MAX_FILL + 1) : c === "ratioRange" ? MAX_FILL + 1 : ratio;
  const garbage = `0x${"00".repeat(40)}`;
  const sentBinary = c === "nonHex" ? "0xzz" : c === "garbage" ? garbage : binary;
  const proof = {
    orderId: c === "order" ? "nope" : route.orderId,
    routeHash: c === "routeHash" ? W("01") : route.routeHash,
    sourcePullId: c === "pullSwap" ? pullOf(route, "target").pullId : pullOf(route, "source").pullId,
    targetPullId: c === "pullSwap" ? pullOf(route, "source").pullId : pullOf(route, "target").pullId,
    fillRatio: proofRatio,
    cumulativeSourceAmount: chainShare(route.source.amount, proofRatio) + (c === "amount" && leg === "source" ? 1n : 0n),
    cumulativeTargetAmount: chainShare(route.target.amount, proofRatio) + (c === "amount" && leg === "target" ? 1n : 0n),
    binaryHash: c === "binaryHash" ? W("00") : c === "garbage" ? ethers.keccak256(garbage) : c === "nonHex" ? W("00") : ethers.keccak256(binary),
    closeMode: c === "mode" ? "bogus" : closeMode(proofRatio),
  };
  const pullId = c === "missing" ? `${pullOf(route, leg).pullId}:gone` : pullOf(route, leg).pullId;
  return asOg<WireAccountTx>({ type: "cross_pull_close", pullId, binary: sentBinary, proof });
};

// ---- lockstep: both engines apply each tx; a refusal must carry og's text and thrown-ness ----
type Step = { readonly tx: WireAccountTx; readonly byLeft: boolean };
const planOf = ({ route, seed }: Route): readonly Step[] => {
  const makerIsLeft = route.makerEntityId === LEFT;
  const hubIsLeft = !makerIsLeft;
  const targetHere = route.target.jurisdiction === HERE;
  const ratio = pick([0, 1, 32_767, 65_534, MAX_FILL, ri(MAX_FILL + 1)]);
  const legs: readonly Leg[] = targetHere ? ["source", "target"] : ["source"];
  // the maker sometimes offers before its source pull is locked: og refuses the unpaired offer
  const early: readonly Step[] = rng() < 0.2 ? [{ tx: offerTx(route), byLeft: makerIsLeft }] : [];
  const locks = legs.map((leg) => ({ tx: lockTx(route, leg), byLeft: rng() < 0.5 }));
  const offer = { tx: offerTx(route), byLeft: rng() < 0.8 ? makerIsLeft : hubIsLeft };
  const closes = legs.map((leg) => ({
    tx: closeTx(route, leg, seed, ratio, pick(CORRUPTIONS)), byLeft: rng() < 0.8 ? hubIsLeft : makerIsLeft,
  }));
  return [...early, ...locks, offer, ...closes];
};
/** og's message with hex and numbers folded, so the tally names the check rather than the instance. */
const shape = (m: string): string => m.replace(/0x[0-9a-fA-F]+|-?\d+/g, "#").slice(0, 48);

describe("coverage-account-failures: cross-j close and offer refusals carry og's text", () => {
  test("MATCH: 150 random cross-j lock / offer / corrupted-close sequences -- og's refusal text at every refusal", async () => {
    const texts = new Map<string, number>();
    for (let n = 0; n < 150; n++) {
      const start = openAccount(pick([0n, 10n ** 13n, 10n ** 20n]));
      const replica = { current: ogReplicaOf(start) };
      const routes = Array.from({ length: 1 + ri(2) }, () => restingRoute(rng() < 0.5, rng() < 0.6));
      const steps = routes.flatMap(planOf);
      await steps.reduce(async (prior, { tx, byLeft }, i) => {
        const body = await prior;
        const label = `seed=${SEED} case=${n} step=${i} ${tx.type}`;
        const ctx: FoldCtx = { byLeft, nowMs: 1000n, jHeight: 3n, accountHeight: 1n };
        const og = await ogApply(replica, tx, byLeft, 1000, 3);
        const rw = applyAccountBody(body, tx, ctx);
        if (rw.ok) {
          expect([label, og.ok ? og.root : `refused: ${og.message}`]).toEqual([label, unwrap(committed(rw.value.state)).root]);
          return rw.value.state;
        }
        const f: AccountTxFailure = accountTxFailure(body, tx, ctx, rw.error, LEFT, { nextProofNonce: 1 });
        const ogText = og.ok ? { accepted: true } : { thrown: og.thrown, message: og.message };
        expect([label, stableJson({ thrown: f.thrown, message: f.message })]).toEqual([label, stableJson(ogText)]);
        texts.set(shape(f.message), (texts.get(shape(f.message)) ?? 0) + 1);
        return body;
      }, Promise.resolve(start));
    }
    // every evidence check, the binary checks, the sender check and the offer's quantization and pairing are reached
    const summary = `seed=${SEED} ${JSON.stringify([...texts])}`;
    const reached = (prefix: string): boolean => [...texts.keys()].some((k) => k.startsWith(prefix));
    for (const k of ["Cross-j close proof ratio out of uint#", "Cross-j close mode invalid", "Cross-j close proof mismatch: order",
      "Cross-j close proof mismatch: routeHash", "Cross-j close proof mismatch: source pull",
      "Cross-j close proof mismatch: source amount", "Cross-j close binary hash mismatch", "Invalid cross-j close binary",
      "Cross-j close ratio mismatch", "Only the ", "Cross-j close pull missing",
      "Cross-j base amount must align", "Cross-j source amount changed", "Cross-j swap offer requires paired"]) {
      expect([summary, k, reached(k)]).toEqual([summary, k, true]);
    }
  }, 120_000);
});
