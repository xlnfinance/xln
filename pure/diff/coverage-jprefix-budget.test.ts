// Coverage: the frame byte budget of a validator's local J prefix claim (og jurisdiction/machine/history/
// j-prefix-consensus.ts buildBudgetedLocalClaim, range-budget.ts) against live og. A local history whose events
// outgrow one Entity frame (10 MiB) is cut back to the highest prefix that fits; a single block too big for any frame
// is terminal.
import { describe, expect, test } from "bun:test";
import { buildLocalJPrefixAttestation as ogBuildLocalJPrefixAttestation } from "../../core/jurisdiction/machine/history/j-prefix-consensus.ts";
import { compareCanonicalJurisdictionEvents, normalizeJurisdictionEvent } from "../../core/jurisdiction/machine/events/event-normalization.ts";
import { canonicalJurisdictionEventsHash, getJEventJurisdictionRef } from "../../core/jurisdiction/machine/event-observation.ts";
import { registerSignerKey } from "../../core/account/crypto.ts";
import {
  buildLocalJPrefixAttestation, committedView, createEntity, jPrefixVerify, localProof, queuedProofBody,
  type EntityFrameHash, type EntityState, type JPrefixCrypto, type JPrefixView, type ValidatorJBlock, type ValidatorJHistory,
} from "../xln.ts";
import { ALICE, TERMS, TEST_CONTRACTS, aliceAddr, anvilKey, genesisAB, signDigestHex, unwrap } from "../xln_run.ts";

// ---- seeded randomness: SEEDX overrides the fixed seed, and every failure names the seed ----
const SEED = process.env["SEEDX"] ? Number(process.env["SEEDX"]) : 0xb0d9e7;
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
/** og's typed shells are built from plain data; this is the one place a shell is given its og type. */
const asOg = <T,>(shell: unknown): T => shell as T;
const word = (): string => `0x${Array.from({ length: 64 }, () => "0123456789abcdef"[ri(16)]).join("")}`;
const Z32 = `0x${"00".repeat(32)}`;

const EP = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
const OG_J = { name: "j", chainId: TERMS.domain.chainId, depositoryAddress: TERMS.domain.depositoryAddress, entityProviderAddress: EP };
const JREF = getJEventJurisdictionRef(OG_J);
const SIGNER = aliceAddr.toLowerCase();
const KEY = anvilKey(2);
const crypto: JPrefixCrypto = {
  verify: jPrefixVerify,
  sign: (_signer, digest) => ({ ok: true, value: signDigestHex(digest, KEY) }),
};
const OG_ENV = { quietRuntimeLogs: true, runtimeSeed: `0x${"11".repeat(32)}` };
registerSignerKey(asOg(OG_ENV), SIGNER, Buffer.from(KEY.slice(2), "hex"));
const MIB = 1024 * 1024;
const BODY = queuedProofBody(unwrap(localProof(unwrap(committedView(genesisAB().state)), { ok: true, value: TEST_CONTRACTS.deltaTransformer })).body);

// ---- a 1-of-1 Entity at certified height L and its signer's local J history above it ----
const L = 4;
const entity = (): { readonly view: JPrefixView; readonly og: unknown } => {
  const jc = { name: "j", entityProviderAddress: EP, entityProviderDeploymentBlock: L + 1 };
  const created = unwrap(createEntity({
    id: ALICE, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]),
    jurisdictionConfig: jc, committed: { lastFinalizedJHeight: L },
  }));
  const parent = word();
  const view: JPrefixView = { state: { ...created.state, height: 1n } as EntityState, head: { height: 1n, prevFrameHash: asOg<EntityFrameHash>(parent) } };
  const og = {
    entityId: ALICE, height: 1, prevFrameHash: parent, lastFinalizedJHeight: L,
    config: { mode: "proposer-based", threshold: 1n, validators: [SIGNER], shares: { [SIGNER]: 1n }, jurisdiction: { ...OG_J, entityProviderDeploymentBlock: L + 1 } },
  };
  return { view, og };
};
// og's hex-bytes check is one regex over the whole argument, which gives up past a few MiB, so weight is spread over
// several events of at most CHUNK bytes each.
const CHUNK = MIB / 2;
/** One DisputeStarted whose starter arguments weigh `bytes`: event bytes are what the budget counts. */
const heavyEvent = (height: number, blockHash: string, logIndex: number, bytes: number): unknown => {
  const data = {
    sender: ALICE, counterentity: `0x${"22".repeat(32)}`, nonce: "1", proposerIsLeft: true, proofbodyHash: Z32, watchSeed: TERMS.watchSeed,
    starterInitialArguments: `0x${"ab".repeat(bytes)}`, starterCounterArguments: "0x", starterCounterProofCommitment: Z32,
    initialProofbody: BODY, disputeTimeout: 100, disputeStartTimestamp: 10, leftResponseSeconds: 45, rightResponseSeconds: 45,
  };
  const normalized = normalizeJurisdictionEvent(asOg({ type: "DisputeStarted", data, blockNumber: height, blockHash, transactionHash: word(), logIndex }));
  if (normalized === null || normalized === undefined) throw new Error("og refused to normalize the fixture event");
  return normalized;
};
/** One J block whose events weigh `bytes` in all. */
const heavyBlock = (height: number, blockHash: string, bytes: number): ValidatorJBlock => {
  const chunks = Array.from({ length: Math.ceil(bytes / CHUNK) }, (_, i) => Math.min(CHUNK, bytes - i * CHUNK));
  const events = chunks.map((b, i) => heavyEvent(height, blockHash, i, b)).sort(asOg(compareCanonicalJurisdictionEvents));
  return asOg<ValidatorJBlock>({ jurisdictionRef: JREF, jHeight: height, jBlockHash: blockHash, eventsHash: canonicalJurisdictionEventsHash(asOg(events)), events });
};
/** A contiguous history from L through L + weights.length, one weighted event block per height. */
const history = (weights: readonly number[]): ValidatorJHistory => {
  const scanned = L + weights.length;
  const blockHashes = new Map(Array.from({ length: weights.length + 1 }, (_, i) => [L + i, word()] as const));
  const eventBlocks = new Map(weights.map((bytes, i) => {
    const h = L + 1 + i;
    return [h, heavyBlock(h, blockHashes.get(h) ?? "", bytes)] as const;
  }));
  return { jurisdictionRef: JREF, scannedThroughHeight: scanned, contiguousThroughHeight: scanned, tipBlockHash: blockHashes.get(scanned) ?? "", eventBlocks, blockHashes };
};
type Outcome = { readonly ok: true; readonly tip: number | null } | { readonly ok: false; readonly message: string };
const ogOutcome = (og: unknown, h: ValidatorJHistory): Outcome => {
  try {
    const a = ogBuildLocalJPrefixAttestation(asOg(OG_ENV), asOg({ signerId: SIGNER, state: og, jHistory: h }), asOg(h));
    return { ok: true, tip: a === null ? null : a.scannedThroughHeight };
  } catch (e) {
    return { ok: false, message: String((e as Error).message) };
  }
};
const rwOutcome = (view: JPrefixView, h: ValidatorJHistory): Outcome => {
  const a = buildLocalJPrefixAttestation(view, SIGNER, h, crypto);
  if (!a.ok) return { ok: false, message: a.error.message };
  return { ok: true, tip: a.value === null ? null : a.value.scannedThroughHeight };
};

describe("coverage-jprefix-budget: the local J prefix claim is cut to one frame's byte budget (og buildBudgetedLocalClaim)", () => {
  test("MATCH: histories over the 10 MiB frame budget -- og's highest fitting prefix, or its terminal single-block refusal", () => {
    const cases: readonly (readonly [string, readonly number[]])[] = [
      // the whole history fits: no search
      ["fits", [MIB, MIB]],
      // 4 MiB blocks: two fit, the third tips over, found by the binary search
      ["cut", [4 * MIB, 4 * MIB, 4 * MIB, MIB]],
      // a random mix, 1..4 MiB per block
      ["mixed", Array.from({ length: 6 }, () => MIB + ri(3 * MIB))],
      // the first block alone is over any frame: terminal
      ["lone", [11 * MIB, MIB]],
      // a later lone block over budget is terminal too, although the prefix below it fits
      ["lone-later", [MIB, 11 * MIB]],
    ];
    const outcomes = cases.map(([name, weights]) => {
      const { view, og } = entity();
      const h = history(weights);
      const label = `seed=${SEED} ${name} ${JSON.stringify(weights)}`;
      const o = ogOutcome(og, h);
      expect([label, rwOutcome(view, h)]).toEqual([label, o]);
      return [name, o] as const;
    });
    // the cases reach each branch: a whole fit, a cut prefix and the terminal lone block
    const byName = new Map(outcomes);
    expect(byName.get("fits")).toEqual({ ok: true, tip: L + 2 });
    expect(byName.get("cut")).toEqual({ ok: true, tip: L + 2 });
    expect(byName.get("lone")).toMatchObject({ ok: false });
  }, 300_000);
});
