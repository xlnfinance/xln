// og local admission (core/entity/command/index.ts prepareLocallyAuthoredEntityTxs) and frame tx authorization
// (core/entity/consensus/frame/application.ts assertEntityTxAuthorization) vs pure/xln.ts. Every test is MATCH and
// runs og live on the same input.
import { describe, expect, test } from "bun:test";
import { lcg31, seedOf, seedTag, untilCovered } from "./seed.ts";

// ---- og ----
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from "../../core/account/crypto.ts";
import { computeEntityAccountValueHash } from "../../core/entity/consensus/state-root.ts";
import { encodeBoard, hashBoard } from "../../core/entity/factory.ts";
import { PersistentEntityAccountMap } from "../../core/entity/state/persistent-account-map.ts";
import { createEmptyEnv } from "../../core/runtime/composition.ts";
import { applyEntityFrameWithMaterializedTestInfraContext } from "../../core/__tests__/helpers/entity-frame.ts";
import { provisionTestEntityEncryptionKey } from "../../core/__tests__/helpers/cross-j.ts";

// ---- rewrite ----
import {
  applyEntityInput, authorEntityTxs, createEntity, foldTxs, tokenId, wireEntityTx,
  type EntityId, type EntityTx, type Hash,
} from "../xln.ts";
import { ALICE, BOB, CAROL, NOW, TERMS, aliceAddr, crypto, hankoVerify, unwrap, verifiers } from "../xln_run.ts";
import { ogAuthored, ogAuthorVerdict, wired } from "./og-author.ts";

/** An EntityProvider that registered no board: og config.jurisdiction is present, the stack is unregistered. */
const J = { entityProviderAddress: `0x${"ee".repeat(20)}` };
const alice = (registered: boolean) =>
  unwrap(createEntity({
    id: ALICE, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]),
    ...(registered ? { jurisdictionConfig: J } : {}),
  }));
const signAlice = (h: Hash) => crypto.sign(h, aliceAddr);
const upperBody = (hex: string): string => `0x${hex.slice(2).toUpperCase()}`;

describe(seedTag("coverage-admission: og materializeLocallyAuthoredEntityTx before signing"), () => {
  const { chainId, depositoryAddress } = TERMS.domain;
  const domains = [
    TERMS.domain,
    { chainId, depositoryAddress: upperBody(depositoryAddress) },
    { chainId: chainId + 1, depositoryAddress },
    { chainId, depositoryAddress: `0x${"ab".repeat(20)}` },
    { chainId: 0, depositoryAddress },
    { chainId, depositoryAddress: "0x12" },
  ];
  const seeds = [TERMS.watchSeed, upperBody(TERMS.watchSeed), "0x12", ""];
  const clocks = [
    TERMS.disputeConfig,
    { leftResponseSeconds: 5, rightResponseSeconds: 7 },
    { leftResponseSeconds: -1, rightResponseSeconds: 7 },
    { leftResponseSeconds: 5, rightResponseSeconds: 1.5 },
    { leftResponseSeconds: 365 * 24 * 60 * 60, rightResponseSeconds: 1 },
    { leftResponseSeconds: 2 ** 32, rightResponseSeconds: 0 },
  ];
  const routes: readonly (readonly string[])[] = [
    [],
    [ALICE, BOB],
    [ALICE, CAROL, BOB],
    [BOB, ALICE],
    [ALICE, CAROL],
    [ALICE, "", BOB],
    [upperBody(ALICE), BOB],
    [ALICE, ...Array.from({ length: 100 }, () => CAROL), BOB],
  ];

  test("MATCH: random openAccount / directPayment batches: og's refusal code at admission, or og's exact signed txs", () => {
    let rng = seedOf(0x0ad3_1551);
    const next = (n: number): number => {
      rng = lcg31(rng);
      return rng % n;
    };
    const pick = <T>(xs: readonly T[]): T => xs[next(xs.length)] as T;
    const openAccount = (): EntityTx => ({
      type: "openAccount",
      data: {
        targetEntityId: pick([BOB, CAROL]),
        accountDomain: { ...pick(domains) },
        watchSeed: pick(seeds),
        disputeConfig: { ...pick(clocks) },
      },
    });
    const directPayment = (): EntityTx => ({
      type: "directPayment",
      data: {
        targetEntityId: BOB, tokenId: unwrap(tokenId("1")), amount: 5n, deliveryMode: "direct",
        route: pick(routes) as readonly EntityId[],
      },
    });
    const chat: EntityTx = { type: "chat", data: { from: aliceAddr.toLowerCase(), message: "hi" } };
    const seen = new Set<string>();
    for (let i = 0, more = untilCovered(300, () => seen.size >= 12); more(i); i++) {
      const state = alice(next(5) > 0).state;
      const batch = Array.from({ length: 1 + next(3) }, () => pick([openAccount, directPayment, () => chat])());
      const og = ogAuthorVerdict(state, aliceAddr, batch);
      const rw = authorEntityTxs(state, aliceAddr, batch, signAlice);
      seen.add(og.split(/[:\s]/)[0] ?? og);
      if (og === "ok") {
        expect(rw.ok).toBe(true);
        if (rw.ok) expect(wired(rw.value)).toEqual(ogAuthored(state, aliceAddr, batch));
      } else {
        expect(rw).toEqual({ ok: false, error: { _tag: "entity_invariant", reason: og } });
      }
    }
    expect([...seen].sort()).toEqual([
      "ACCOUNT_DISPUTE_LEFT_RESPONSE_SECONDS_INVALID",
      "ACCOUNT_DISPUTE_RESPONSE_TOTAL_EXCEEDED",
      "ACCOUNT_DISPUTE_RIGHT_RESPONSE_SECONDS_INVALID",
      "ACCOUNT_STATE_DOMAIN_INVALID",
      "DIRECT_PAYMENT_ROUTE_END_INVALID",
      "DIRECT_PAYMENT_ROUTE_ENTRY_INVALID",
      "DIRECT_PAYMENT_ROUTE_REQUIRED",
      "DIRECT_PAYMENT_ROUTE_START_INVALID",
      "DIRECT_PAYMENT_ROUTE_TOO_LONG",
      "OPEN_ACCOUNT",
      "OPEN_ACCOUNT_DOMAIN_MISMATCH",
      "OPEN_ACCOUNT_SOURCE_JURISDICTION_REQUIRED",
      "ok",
    ]);
  }, 60_000);

  test("MATCH: an Entity with no jurisdiction refuses a local openAccount at admission, before any frame", () => {
    const r = alice(false);
    const open: EntityTx = {
      type: "openAccount",
      data: { targetEntityId: BOB, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed,
        disputeConfig: { ...TERMS.disputeConfig } },
    };
    const og = ogAuthorVerdict(r.state, aliceAddr, [open]);
    expect(og).toBe(`OPEN_ACCOUNT_SOURCE_JURISDICTION_REQUIRED:${ALICE}`);
    const input = { kind: "txs" as const, timestamp: NOW, txs: [open] };
    const out = applyEntityInput(r, input, { ...verifiers, self: ALICE, signerId: aliceAddr });
    expect(out).toEqual({ ok: false, error: { _tag: "entity_invariant", reason: og } });
  });
});

describe(seedTag("coverage-admission: og assertEntityTxAuthorization on a frame's top-level txs"), () => {
  /** og's signed-entity-command.test.ts setup: a 1-of-1 lazy Entity on a jurisdiction, its key provisioned. */
  const ogSetup = () => {
    const seed = "coverage-admission:raw-frame";
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.state.timestamp = 1_000;
    const signerId = deriveSignerAddressSync(seed, "validator").toLowerCase();
    registerSignerKey(env, signerId, deriveSignerKeySync(seed, "validator"));
    const jurisdiction = {
      address: `0x${"a1".repeat(20)}`, name: "CoverageAdmission", chainId: TERMS.domain.chainId,
      depositoryAddress: TERMS.domain.depositoryAddress, entityProviderAddress: J.entityProviderAddress,
    };
    const config = { mode: "proposer-based", threshold: 1n, validators: [signerId], shares: { [signerId]: 1n },
      jurisdiction };
    const id = hashBoard(encodeBoard(config as never)).toLowerCase();
    const state: Record<string, unknown> = {
      entityId: id, height: 0, timestamp: 0, nonces: new Map(), proposals: new Map(), config, reserves: new Map(),
      accounts: PersistentEntityAccountMap.empty(id, computeEntityAccountValueHash), lastFinalizedJHeight: 0,
      profile: { name: "", isHub: false, avatar: "", bio: "", website: "" },
      paybook: { entries: new Map(), feesEarned: 0n },
      entityEncryptionPublicKey: provisionTestEntityEncryptionKey(env, id),
    };
    env.state.eReplicas.set(`${id}:${signerId}`, { entityId: id, signerId, state: state as never, mempool: [],
      isProposer: true });
    return { env, state };
  };
  const ogRefusal = async (tx: EntityTx): Promise<string> => {
    const { env, state } = ogSetup();
    try {
      await applyEntityFrameWithMaterializedTestInfraContext(env as never, state as never, [wireEntityTx(tx)] as never,
        1_001);
      return "ok";
    } catch (e) {
      return (e as Error).message;
    }
  };
  const tk = unwrap(tokenId("1"));
  const raw: readonly EntityTx[] = [
    { type: "setHubConfig", data: { routingFeePPM: 777, baseFee: 123n } } as EntityTx,
    { type: "chat", data: { from: aliceAddr.toLowerCase(), message: "raw" } },
    { type: "chatMessage", data: { message: "raw", timestamp: 1 } },
    { type: "openAccount", data: { targetEntityId: BOB, accountDomain: { ...TERMS.domain },
      watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig } } },
    { type: "extendCredit", data: { counterpartyEntityId: BOB, tokenId: tk, amount: 5n } },
    { type: "directPayment", data: { targetEntityId: BOB, tokenId: tk, amount: 5n, route: [ALICE, BOB],
      deliveryMode: "direct" } },
    { type: "requestCollateral", data: { counterpartyEntityId: BOB, tokenId: tk, amount: 5n, feeAmount: 0n,
      policyVersion: 1 } },
    { type: "disputeFinalize", data: { counterpartyEntityId: BOB } },
    { type: "processHtlcTimeouts", data: {} },
  ];

  test("MATCH: every raw non-protocol tx at a frame's top level is og ENTITY_COMMAND_REQUIRED", async () => {
    const r = alice(true);
    const verdicts = await Promise.all(raw.map(ogRefusal));
    expect(verdicts).toEqual(raw.map((tx) => `ENTITY_COMMAND_REQUIRED:${tx.type}`));
    const replayed = raw.map((tx) => foldTxs(r.state, r.accountReplicas, [tx], { verify: hankoVerify, timestamp: NOW }));
    expect(replayed).toEqual(verdicts.map((reason) => ({ ok: false, error: { _tag: "entity_invariant", reason } })));
  });
});
