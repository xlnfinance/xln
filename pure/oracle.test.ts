import { describe, expect, test } from "bun:test";
import { deriveDelta } from "../core/account/utils.ts";
import { accountId as lexicalAccountId } from "./lexical-id.stub.ts";
import { isLeftEntity } from "../core/protocol/identity/entity-id.ts";
import { deriveTransferOffdeltaChange } from "../core/protocol/transform/delta-movement.ts";
import {
  accountFrameHash,
  accountId,
  accountTerms,
  accountDisputeHash,
  admit,
  accountProofBody,
  allowedProposer,
  applyAccountBody,
  applyEntityInput,
  createEntity,
  quorumBoardHash,
  applyAccountInput,
  chargeSettlement,
  committed,
  localProof,
  entityFrameHash,
  hashEntityFrame,
  entityId,
  entityStateRoot,
  EMPTY_J_ROOT,
  hashEntityState,
  frameStateHash,
  previewAccountProposal,
  genesisAccount,
  genesisAccountBody,
  genesisReplica,
  getDelta,
  holds,
  hashHtlcSecret,
  offdeltaChange,
  outCapacity,
  setCreditLimit,
  zeroDelta,
  MAX_CREDIT_LIMIT,
  MAX_FILL,
  address,
  bytesToHex,
  concat,
  hexToBytes,
  recoverRawSigner,
  signRaw,
  signature,
  wordOf,
  wireEntityTx,
  tokenId,
  type AccountBody,
  type Hash,
  type Delta,
  type EntityFrameHashInput,
  type FoldCtx,
} from "./xln.ts";
import { anvilKey, crypto, signerAddress } from "./xln_run.ts";
import { consensusBytes, ogAfterCommands, ogAuthored, ogAuthorVerdict, ogCommandState } from "./diff/og-author.ts";
import { ogOf } from "./diff/og-state.ts";

const word = (byte: string): string => `0x${byte.repeat(32)}`;
/** og jBlockHash is a 0x-prefixed block hash; the rewrite's Hash brand has no 0x constructor, so this one fixture is branded directly. */
const jBlock = (s: string): Hash => s as Hash;
const ACCOUNT_FRAME_GOLDEN = "0x48209002630a2dae349c0ec270c3668afd11e7bad2970121e24d7af157fdc75b";
const SETTLEMENT_GOLDEN = "0x31c1e688138ea34d358f85463110cac28bbb667cf756fd6d369aebff9c69330b";
const SETTLEMENT_HASH_MOVED = "0x2bbd97062af15e91acbf9af9973adbad7b3494d67f8c955d8ab9a5d2e8267cd4";
const ENTITY_FRAME_GOLDEN = "0xbf89526cad961e2b2800ac3d78101b0b35c790b65a02f3a7834397afda12d8d0";
const ENTITY_STATE_ROOT = "0x9b55ab751f698879e3215f49008d58305333e699fd7aaaeba87c5eb057206a9c";
const ENTITY_AUTHORITY_ROOT = "0xa7c4fd7139d47d2567c6a97c7d7d06bc6d60fc4481acbe8155584f3573b520bd";

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error, (_, value: unknown) => (typeof value === "bigint" ? value.toString() : value)));
  return result.value;
};
const T0 = unwrap(tokenId("0")), T1 = unwrap(tokenId("1"));

const accountFixture = () => ({
  height: 7,
  timestamp: 1_700_000_000_123,
  jHeight: 42,
  prevFrameHash: word("11"),
  accountStateRoot: word("33"),
  accountTxs: [
    { type: "set_credit_limit", data: { tokenId: 1, amount: 1234n } },
    { type: "direct_payment", data: { tokenId: 1, amount: 55n, nonce: "payment-1" } },
  ],
});

const settlement = (settlementHash: string, settlementHanko: string, hanko: string) => ({
  type: "settle_transition",
  data: {
    kind: "hanko",
    revision: 1,
    workspaceHash: word("61"),
    settlementNonce: 2,
    settlementHash,
    settlementHanko,
    postProof: { nonce: 3, proposerIsLeft: true, proofBodyHash: word("63"), disputeHash: word("64"), hanko },
  },
});

const entityContext = () => ({
  version: 1,
  proposerReplicaId: `${word("aa")}:0x${"01".repeat(20)}`,
  entityId: word("aa"),
  proposerSignerId: `0x${"01".repeat(20)}`,
  parentFrameHash: word("22"),
  height: 4,
  gossipProfiles: [],
  peerAssertions: [],
  htlc: { version: 1, entries: [], originated: [] },
});

const entityInput = (frameHanko: string): EntityFrameHashInput => {
  const frame = { ...accountFixture(), stateHash: unwrap(accountFrameHash(accountFixture())) };
  return {
    prevFrameHash: word("22"),
    height: 4,
    timestamp: 1_700_000_000_456,
    txs: [{ type: "accountInput", data: { kind: "ack_frame", fromEntityId: word("aa"), toEntityId: word("bb"), proposal: { frame, frameHanko } } }],
    events: [],
    entityId: word("aa"),
    stateRoot: ENTITY_STATE_ROOT,
    authorityRoot: ENTITY_AUTHORITY_ROOT,
    entityContext: entityContext(),
  };
};

type Money = {
  collateral?: bigint; ondelta?: bigint; offdelta?: bigint;
  leftCreditLimit?: bigint; rightCreditLimit?: bigint;
  leftAllowance?: bigint; rightAllowance?: bigint; leftHold?: bigint; rightHold?: bigint;
};

const capacities = (money: Money): { left: bigint; right: bigint } => {
  const theirs = {
    tokenId: 1,
    collateral: money.collateral ?? 0n,
    ondelta: money.ondelta ?? 0n,
    offdelta: money.offdelta ?? 0n,
    leftCreditLimit: money.leftCreditLimit ?? 0n,
    rightCreditLimit: money.rightCreditLimit ?? 0n,
    leftAllowance: money.leftAllowance ?? 0n,
    rightAllowance: money.rightAllowance ?? 0n,
    leftHold: money.leftHold ?? 0n,
    rightHold: money.rightHold ?? 0n,
  };
  const fold: Delta = { ...zeroDelta(T1), ...theirs, tokenId: T1 };
  return {
    left: outCapacity(fold, true, theirs.leftHold + theirs.leftAllowance),
    right: outCapacity(fold, false, theirs.rightHold + theirs.rightAllowance),
  };
};

describe("oracle", () => {
  test("account frame hash is their frozen golden", () => {
    expect(unwrap(accountFrameHash(accountFixture()))).toBe(ACCOUNT_FRAME_GOLDEN);
  });

  test("settlement hanko text is outside the frame hash and settlementHash is inside", () => {
    const base = unwrap(accountFrameHash({ ...accountFixture(), accountTxs: [settlement(word("62"), "0xfirst-quorum", "0xfirst-proof-quorum")] }));
    const otherQuorum = unwrap(accountFrameHash({ ...accountFixture(), accountTxs: [settlement(word("62"), "0xsecond-quorum", "0xsecond-proof-quorum")] }));
    const otherTarget = unwrap(accountFrameHash({ ...accountFixture(), accountTxs: [settlement(word("65"), "0xsecond-quorum", "0xsecond-proof-quorum")] }));
    expect(base).toBe(SETTLEMENT_GOLDEN);
    expect(otherQuorum).toBe(base);
    expect(otherTarget).toBe(SETTLEMENT_HASH_MOVED);
  });

  test("entity frame hash is their frozen golden, and the frame hanko moves it", () => {
    expect(unwrap(entityFrameHash(entityInput("0x1234")))).toBe(ENTITY_FRAME_GOLDEN);
    expect(unwrap(entityFrameHash(entityInput("0x5678")))).not.toBe(ENTITY_FRAME_GOLDEN);
  });

  test("payment sign matches deriveTransferOffdeltaChange, and a negative amount is refused", () => {
    for (const amount of [0n, 1n, 7n, 1n << 128n]) {
      expect(unwrap(offdeltaChange(true, amount))).toBe(deriveTransferOffdeltaChange(true, amount));
      expect(unwrap(offdeltaChange(false, amount))).toBe(deriveTransferOffdeltaChange(false, amount));
    }
    expect(unwrap(offdeltaChange(true, 10n))).toBe(deriveTransferOffdeltaChange(true, 10n));
    expect(unwrap(offdeltaChange(false, 30n))).toBe(deriveTransferOffdeltaChange(false, 30n));
    expect(() => deriveTransferOffdeltaChange(true, -1n)).toThrow("TRANSFER_AMOUNT_NEGATIVE");
    expect(offdeltaChange(true, -1n)).toEqual({ ok: false, error: { _tag: "negative_transfer" } });
  });

  test("swap legs are the payment sign and its opposite", () => {
    const legs = (makerIsLeft: boolean, give: bigint, want: bigint) => ({
      give: unwrap(offdeltaChange(makerIsLeft, give)),
      want: unwrap(offdeltaChange(!makerIsLeft, want)),
    });
    expect(legs(true, 10n, 30n)).toEqual({ give: deriveTransferOffdeltaChange(true, 10n), want: deriveTransferOffdeltaChange(false, 30n) });
    expect(legs(false, 10n, 30n)).toEqual({ give: deriveTransferOffdeltaChange(false, 10n), want: deriveTransferOffdeltaChange(true, 30n) });
  });

  test("left is their isLeftEntity", () => {
    const pairs: readonly (readonly [string, string])[] = [
      [word("aa"), word("bb")],
      [word("BB"), word("aa")],
      ["0x0b", `${word("00").slice(0, -2)}0c`],
      ["alice", "bob"],
      [word("ab"), word("cd")],
    ];
    for (const [left, right] of pairs) {
      const first = unwrap(entityId(left)), second = unwrap(entityId(right));
      expect(unwrap(accountId(first, second)).left === first).toBe(isLeftEntity(left, right));
    }
    const upper = word("ab");
    const lower = `0x${"AB".repeat(32)}`;
    expect(isLeftEntity(upper, lower)).toBe(false);
    expect(accountId(unwrap(entityId(upper)), unwrap(entityId(lower)))).toEqual({ ok: false, error: { _tag: "same_entity" } });
    const rawHigh = `0x${"B0"}${"00".repeat(31)}`;
    const rawLow = `0x${"a0"}${"00".repeat(31)}`;
    const high = unwrap(entityId(rawHigh));
    const low = unwrap(entityId(rawLow));
    expect(lexicalAccountId(high, low).left).toBe(high);
    expect(unwrap(accountId(high, low)).left).toBe(low);
    expect(BigInt(rawLow) < BigInt(rawHigh)).toBe(true);
  });

  test("outgoing capacity matches deriveDelta", () => {
    const rows: Money[] = [
      { collateral: 100n, leftCreditLimit: 10n, rightCreditLimit: 20n, ondelta: 30n },
      { collateral: 100n, leftCreditLimit: 10n, rightCreditLimit: 20n, ondelta: -30n },
      { collateral: 40n, leftCreditLimit: 80n, rightCreditLimit: 120n, ondelta: 90n, leftHold: 7n, rightHold: 11n },
      { collateral: 50n, leftCreditLimit: 20n, rightCreditLimit: 20n, leftAllowance: 5n, rightAllowance: 9n },
      { leftCreditLimit: 100n, leftHold: 25n, leftAllowance: 7n, rightAllowance: 3n },
    ];
    for (const money of rows) {
      const got = capacities(money);
      const theirs = {
        tokenId: 1,
        collateral: money.collateral ?? 0n,
        ondelta: money.ondelta ?? 0n,
        offdelta: money.offdelta ?? 0n,
        leftCreditLimit: money.leftCreditLimit ?? 0n,
        rightCreditLimit: money.rightCreditLimit ?? 0n,
        leftAllowance: money.leftAllowance ?? 0n,
        rightAllowance: money.rightAllowance ?? 0n,
        leftHold: money.leftHold ?? 0n,
        rightHold: money.rightHold ?? 0n,
      };
      expect(got.left).toBe(deriveDelta(theirs, true).outCapacity);
      expect(got.right).toBe(deriveDelta(theirs, false).outCapacity);
    }
  });

  test("a left grant writes the right limit, including past the retired uint128 ceiling", () => {
    const grant = ((1n << 128n) - 1n) * 1000n + 1n;
    const left = unwrap(setCreditLimit(zeroDelta(T1), 3n, true));
    const right = unwrap(setCreditLimit(zeroDelta(T1), 4n, false));
    const huge = unwrap(setCreditLimit(zeroDelta(T1), grant, true));
    expect(left.rightCreditLimit).toBe(3n);
    expect(left.leftCreditLimit).toBe(0n);
    expect(right.leftCreditLimit).toBe(4n);
    expect(huge.rightCreditLimit).toBe(grant);
    expect(setCreditLimit(zeroDelta(T1), -1n, true)).toEqual({ ok: false, error: { _tag: "negative_credit_limit" } });
    expect(setCreditLimit(zeroDelta(T1), MAX_CREDIT_LIMIT + 1n, true)).toEqual({ ok: false, error: { _tag: "credit_limit_too_large" } });
  });

  test("a payment moves offdelta by their sign and refuses a non-positive amount", () => {
    const alice = unwrap(entityId(word("11")));
    const bob = unwrap(entityId(word("22")));
    const terms = unwrap(accountTerms({
      domain: { chainId: 1, depositoryAddress: `0x${"ab".repeat(20)}` },
      watchSeed: word("44"),
      disputeConfig: { leftResponseSeconds: 1, rightResponseSeconds: 1 },
    }));
    const ctx = { byLeft: true, nowMs: 1n, jHeight: 0n, accountHeight: 0n };
    let body = genesisAccountBody(genesisAccount(unwrap(accountId(alice, bob))), terms);
    body = unwrap(applyAccountBody(body, { type: "set_credit_limit", tokenId: T0, limit: 10n }, ctx)).state;
    body = unwrap(applyAccountBody(body, { type: "set_credit_limit", tokenId: T0, limit: 10n }, { ...ctx, byLeft: false })).state;
    const paid = unwrap(applyAccountBody(body, { type: "payment", tokenId: T0, amount: 4n }, ctx)).state;
    expect(paid.account.deltas.get(T0)?.offdelta).toBe(deriveTransferOffdeltaChange(true, 4n));
    expect(paid.account.deltas.get(T0)?.collateral).toBe(0n);
    expect(paid.account.deltas.get(T0)?.ondelta).toBe(0n);
    const fromRight = unwrap(applyAccountBody(paid, { type: "payment", tokenId: T0, amount: 1n }, { ...ctx, byLeft: false })).state;
    expect(fromRight.account.deltas.get(T0)?.offdelta).toBe(-4n + deriveTransferOffdeltaChange(false, 1n));
    expect(applyAccountBody(body, { type: "payment", tokenId: T0, amount: 0n }, ctx).ok).toBe(false);
    expect(applyAccountBody(body, { type: "payment", tokenId: T0, amount: -1n }, ctx).ok).toBe(false);
  });

  test("an HTLC resolve moves offdelta by their sign and a timeout does not", () => {
    const { body, ctx } = open();
    const secret = word("5a");
    const hashlock = hashHtlcSecret(secret);
    if (hashlock === null) throw new Error("secret");
    const lock = { type: "htlc_lock" as const, lockId: hashlock, hashlock, timelock: 10n ** 15n, revealBeforeHeight: 5n, amount: 5n, tokenId: T0 };
    const locked = unwrap(applyAccountBody(body, lock, ctx)).state;
    expect(getDelta(locked.account, T0).offdelta).toBe(0n);
    expect(outCapacity(getDelta(locked.account, T0), true, holds(locked, T0, true))).toBe(15n);
    const resolved = unwrap(applyAccountBody(locked, { type: "htlc_resolve", lockId: hashlock, outcome: "secret", secret }, ctx)).state;
    expect(getDelta(resolved.account, T0).offdelta).toBe(deriveTransferOffdeltaChange(true, 5n));
    expect(getDelta(resolved.account, T0).collateral).toBe(0n);
    expect(getDelta(resolved.account, T0).ondelta).toBe(0n);
    const proof = unwrap(accountProofBody(unwrap(committed(resolved)).view));
    expect(proof.offdeltas).toEqual([getDelta(resolved.account, T0).offdelta, getDelta(resolved.account, T1).offdelta]);
    expect(proof.tokenIds).toEqual([0n, 1n]);
    expect(resolved.locks.has(hashlock)).toBe(false);
    expect(applyAccountBody(locked, { type: "htlc_resolve", lockId: hashlock, outcome: "secret", secret: word("5b") }, ctx).ok).toBe(false);
    const expired = unwrap(applyAccountBody(locked, { type: "htlc_resolve", lockId: hashlock, outcome: "error", reason: "timeout" }, { ...ctx, jHeight: 6n })).state;
    expect(getDelta(expired.account, T0).offdelta).toBe(0n);
    expect(expired.locks.has(hashlock)).toBe(false);
  });

  test("a filled swap moves give and want by their two signs", () => {
    const { body, ctx } = open();
    const offered = unwrap(applyAccountBody(body, {
      type: "swap_offer", offerId: "S", giveTokenId: T0, giveTokenDecimals: 0, giveAmount: 6n, wantTokenId: T1, wantTokenDecimals: 0, wantAmount: 3n, maxFee: 0n, minNetReceive: 3n,
    }, ctx)).state;
    expect(applyAccountBody(offered, { type: "swap_resolve", offerId: "S", fillRatio: MAX_FILL, cancelRemainder: true, executionGiveAmount: 6n, executionWantAmount: 3n }, ctx).ok).toBe(false);
    const filled = unwrap(applyAccountBody(offered, { type: "swap_resolve", offerId: "S", fillRatio: MAX_FILL, cancelRemainder: true, executionGiveAmount: 6n, executionWantAmount: 3n }, { ...ctx, byLeft: false })).state;
    expect(getDelta(filled.account, T0).offdelta).toBe(deriveTransferOffdeltaChange(true, 6n));
    expect(getDelta(filled.account, T1).offdelta).toBe(deriveTransferOffdeltaChange(false, 3n));
    expect(filled.offers.has("S")).toBe(false);
  });

  test("a settlement workspace keeps the money, holds its outflow and commits the workspace", () => {
    const { body } = open();
    const ctx = { byLeft: true, nowMs: 1n, jHeight: 0n, accountHeight: 1n };
    const before = unwrap(committed(body)).root;
    const tx = { type: "settle_transition" as const, kind: "upsert" as const, revision: 1, ops: [{ type: "r2r" as const, tokenId: 0, amount: 2n }], executorIsLeft: true };
    const applied = unwrap(applyAccountBody(body, tx, ctx)).state;
    expect(getDelta(applied.account, T0).offdelta).toBe(getDelta(body.account, T0).offdelta);
    expect(applied.settlement?.status).toBe("awaiting_counterparty");
    const root = unwrap(committed(applied)).root;
    expect(root).not.toBe(before);
    const otherTarget = unwrap(applyAccountBody(body, { ...tx, ops: [{ type: "r2r" as const, tokenId: 0, amount: 1n }] }, ctx)).state;
    expect(unwrap(committed(otherTarget)).root).not.toBe(root);
    const hash = applied.settlement?.workspaceHash ?? "";
    const cleared = unwrap(applyAccountBody(applied, { type: "settle_transition", kind: "clear", revision: 1, workspaceHash: hash }, { ...ctx, byLeft: false })).state;
    expect(unwrap(committed(cleared)).root).toBe(before);
    const hanko = { type: "settle_transition" as const, kind: "hanko" as const, revision: 1, workspaceHash: hash, settlementNonce: 1, settlementHash: word("62"), settlementHanko: "0x01", postProof: { nonce: 2, proposerIsLeft: true, proofBodyHash: word("63"), disputeHash: word("64"), hanko: "0x02" } };
    expect(applyAccountBody(applied, hanko, ctx).ok).toBe(false);
    expect(unwrap(accountFrameHash({ ...accountFixture(), accountTxs: [{ type: tx.type, data: tx }] })).length).toBeGreaterThan(0);
  });

  test("a proposed right party takes the left party's frame", () => {
    const alice = unwrap(entityId(word("11")));
    const bob = unwrap(entityId(word("22")));
    const id = unwrap(accountId(alice, bob));
    const terms = unwrap(accountTerms({
      domain: { chainId: 1, depositoryAddress: `0x${"ab".repeat(20)}` },
      watchSeed: word("44"),
      disputeConfig: { leftResponseSeconds: 1, rightResponseSeconds: 1 },
    }));
    const verify = (): boolean => true;
    const now = 1_000n;
    const clock = { timestamp: now, jHeight: 0n };
    const opened = unwrap(admit(unwrap(genesisReplica(id, terms)), [{ type: "set_credit_limit", tokenId: T0, limit: 4n }]));
    const preview = unwrap(previewAccountProposal(opened, bob, clock));
    if (preview.dispute._tag !== "sign") throw new Error(preview.dispute._tag);
    const proposed = unwrap(applyAccountInput(opened, { kind: "propose", ...clock, frameHanko: "0xaabb", disputeHanko: { ...preview.dispute.draft, hanko: "0xccdd" } }, { verify, self: bob, now }));
    if (proposed.replica._tag !== "proposed") throw new Error(proposed.replica._tag);
    const own = proposed.replica.candidate.frame.stateHash;
    const leftTx = { type: "set_credit_limit" as const, tokenId: T0, limit: 9n };
    const leftBody = unwrap(applyAccountBody(unwrap(genesisReplica(id, terms)).state, leftTx, { byLeft: true, nowMs: now, jHeight: 0n, accountHeight: 1n })).state;
    const leftView = unwrap(committed(leftBody));
    const proof = unwrap(localProof(leftView.view));
    const disputeHash = unwrap(accountDisputeHash(unwrap(committed(opened.state)).view, proof.bodyHash, proof.jNonce + 1, true));
    const bare = { height: 1n, timestamp: now, jHeight: 0n, prevFrameHash: "genesis", txs: [leftTx], accountStateRoot: leftView.root };
    const stateHash = unwrap(frameStateHash(bare, id, true));
    const taken = unwrap(applyAccountInput(proposed.replica, {
      kind: "ack_frame",
      ack: null,
      frame: { ...bare, stateHash },
      frameHanko: "0xeeff",
      disputeHanko: { hanko: "0x1122", hash: disputeHash, proofBodyHash: proof.bodyHash, proofNonce: proof.jNonce + 1, proposerIsLeft: true },
      fromEntityId: alice,
      toEntityId: bob,
      domain: proposed.replica.state.terms.domain,
      disputeConfig: proposed.replica.state.terms.disputeConfig,
      watchSeed: proposed.replica.state.terms.watchSeed,
    }, { verify, self: bob, now }));
    expect(taken.replica._tag).toBe("received");
    if (taken.replica._tag === "received") {
      expect(taken.replica.candidate.frame.stateHash).toBe(stateHash);
      expect(taken.replica.candidate.frame.stateHash).not.toBe(own);
      expect(getDelta(taken.replica.candidate.draft.state.account, T0).rightCreditLimit).toBe(9n);
    }
  });

  test("a negative settlement diff is a hold against deriveDelta", () => {
    const row = { ...zeroDelta(T1), collateral: 100n, leftCreditLimit: 40n, rightCreditLimit: 10n };
    const hold = unwrap(chargeSettlement(row, { leftDiff: -15n, rightDiff: -4n, collateralDiff: 0n }, { left: 0n, right: 0n }));
    expect(hold).toEqual({ left: 15n, right: 4n });
    const theirs = { tokenId: 1, collateral: 100n, ondelta: 0n, offdelta: 0n, leftCreditLimit: 40n, rightCreditLimit: 10n, leftAllowance: 0n, rightAllowance: 0n, leftHold: hold.left, rightHold: hold.right };
    expect(outCapacity(row, true, hold.left)).toBe(deriveDelta(theirs, true).outCapacity);
    expect(outCapacity(row, false, hold.right)).toBe(deriveDelta(theirs, false).outCapacity);
    expect(chargeSettlement(row, { leftDiff: -1000n, rightDiff: 0n, collateralDiff: 0n }, { left: 0n, right: 0n }).ok).toBe(false);
    expect(unwrap(chargeSettlement(row, { leftDiff: -1000n, rightDiff: 0n, collateralDiff: 50n }, { left: 0n, right: 0n })).left).toBe(1000n);
  });

  test("the entity frame binds a state root the fold computes", () => {
    const alice = unwrap(entityId(word("aa")));
    const bob = unwrap(entityId(word("bb")));
    const signer = unwrap(address(`0x${"01".repeat(20)}`));
    const terms = unwrap(accountTerms({
      domain: { chainId: 1, depositoryAddress: `0x${"ab".repeat(20)}` },
      watchSeed: word("44"),
      disputeConfig: { leftResponseSeconds: 1, rightResponseSeconds: 1 },
    }));
    const created = unwrap(createEntity({ id: alice, jurisdiction: terms.domain, threshold: 1n, members: new Map([[signer, { shares: 1n }]]) }));
    const rootOf = (state: typeof created.state): string => `0x${hashEntityState(state)}`;
    const root = rootOf(created.state);
    expect(rootOf(created.state)).toBe(root);
    const withAccount = rootOf({ ...created.state, accounts: new Map([[bob, genesisAccount(unwrap(accountId(alice, bob)))]]) });
    expect(withAccount).not.toBe(root);
    const base = entityInput("0x1234");
    const hashed = unwrap(entityFrameHash({ ...base, stateRoot: root, authorityRoot: root }));
    expect(unwrap(entityFrameHash({ ...base, stateRoot: root, authorityRoot: root }))).toBe(hashed);
    expect(unwrap(entityFrameHash({ ...base, stateRoot: withAccount, authorityRoot: root }))).not.toBe(hashed);
    expect(hashed).not.toBe(ENTITY_FRAME_GOLDEN);
  });

  test("entity state root is their minimal digest, and one account moves it", () => {
    const self = word("aa");
    const peer = word("bb");
    const signer = `0x${"01".repeat(20)}`;
    const claims = { version: 1 as const, root: EMPTY_J_ROOT, count: 0n };
    const config = { mode: "proposer-based" as const, threshold: 1n, validators: [signer], shares: { [signer]: 1n } };
    const installed = {
      fromEntity: self,
      toEntity: peer,
      status: "active" as const,
      currentHeight: 0,
      nextProofNonce: 1,
      currentFrameHash: "",
      pendingWithdrawals: word("00"),
      policyRoot: word("00"),
      submittedAtByTokenRoot: word("00"),
      state: {
        domain: { chainId: 1, depositoryAddress: `0x${"ab".repeat(20)}` },
        leftEntity: self,
        rightEntity: peer,
        watchSeed: word("44"),
        disputeConfig: { leftResponseSeconds: 1, rightResponseSeconds: 1 },
        jNonce: 0,
        lastFinalizedJHeight: 0,
        leftPendingJClaims: claims,
        rightPendingJClaims: claims,
        deltas: new Map(),
        locks: new Map(),
        pulls: new Map(),
        swapOffers: new Map(),
        subcontracts: new Map(),
        lendingIntents: new Map(),
        requestedRebalance: new Map(),
        requestedRebalanceFeeState: new Map(),
        rebalanceFeePolicies: new Map(),
      },
    };
    const empty = "0x1a37f4d778a6abc66ac52c98367338a4d7dd3d9f92f2f365305a7154bfc6b9a4";
    const withAccount = "0x72ac0104afdbba762c83b6e958f4a9ca787f1706e62f368aab62bfb635f35d2b";
    expect(unwrap(entityStateRoot({ config, accounts: [] }))).toBe(empty);
    expect(unwrap(entityStateRoot({ config, accounts: [installed] }))).toBe(withAccount);
  });

  test("a proposed entity frame hash is entityFrameHash of its own fields", () => {
    const peer = unwrap(entityId(word("bb")));
    // og admission signs the openAccount into the proposer's command: real anvil keys, and a jurisdiction to open under
    const signer = unwrap(address(signerAddress(anvilKey(0))));
    const terms = unwrap(accountTerms({
      domain: { chainId: 1, depositoryAddress: `0x${"ab".repeat(20)}` },
      watchSeed: word("44"),
      disputeConfig: { leftResponseSeconds: 1, rightResponseSeconds: 1 },
    }));
    const second = unwrap(address(signerAddress(anvilKey(1))));
    // og assertQuorumBoardBinding: without a certified registry the Entity id is its own lazy board hash
    const self = unwrap(entityId(quorumBoardHash({ _tag: "teaching", threshold: 2n, members: new Map([[signer, { shares: 1n }], [second, { shares: 1n }]]) })));
    const created = unwrap(createEntity({ id: self, jurisdiction: terms.domain, threshold: 2n, members: new Map([[signer, { shares: 1n }], [second, { shares: 1n }]]), jurisdictionConfig: { entityProviderAddress: `0x${"ee".repeat(20)}` } }));
    const open = { targetEntityId: peer, accountDomain: terms.domain, watchSeed: terms.watchSeed, disputeConfig: terms.disputeConfig };
    const proposed = unwrap(applyEntityInput(created, { kind: "txs", timestamp: 5n, txs: [{ type: "openAccount", data: open }] }, {
      verify: () => true, verifyMember: () => true, sign: crypto.sign, self, signerId: signer,
    }));
    if (proposed.replica._tag !== "proposed") throw new Error(proposed.replica._tag);
    const frame = proposed.replica.frame;
    const ogTxs = ogAuthored(created.state, signer, [{ type: "openAccount", data: open }]);
    expect<unknown[]>(frame.txs.map(wireEntityTx)).toEqual(ogTxs);
    expect<string>(frame.prevFrameHash).toBe("genesis");
    const fields = (stateRoot: string, events: typeof frame.events) => ({
      prevFrameHash: frame.prevFrameHash, height: Number(frame.height), timestamp: Number(frame.timestamp),
      txs: ogTxs as EntityFrameHashInput["txs"], events, entityId: frame.entityContext.entityId,
      stateRoot, authorityRoot: frame.authorityRoot, entityContext: frame.entityContext,
    });
    const hashed = unwrap(hashEntityFrame(frame));
    expect<string>(hashed).toBe(unwrap(entityFrameHash(fields(frame.stateRoot, frame.events))));
    const moved = { ...frame, stateRoot: word("ab") };
    expect<string>(unwrap(hashEntityFrame(moved))).toBe(unwrap(entityFrameHash(fields(word("ab"), frame.events))));
    expect(unwrap(hashEntityFrame(moved))).not.toBe(hashed);
    expect(unwrap(entityFrameHash(entityInput("0x1234")))).toBe(ENTITY_FRAME_GOLDEN);
  });

  test("one claim's frame hash and a second claim's pending root are their digests", () => {
    const left = word("11");
    const right = word("22");
    const id = unwrap(accountId(unwrap(entityId(left)), unwrap(entityId(right))));
    const terms = unwrap(accountTerms({
      domain: { chainId: 31337, depositoryAddress: `0x${"44".repeat(20)}` },
      watchSeed: word("55"),
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    }));
    const settled = (collateral: bigint, ondelta: bigint, nonce: bigint) => ({
      left, right, tokens: [{ tokenId: 1n, leftReserve: 0n, rightReserve: 0n, collateral, ondelta }], nonce,
    });
    const claim = (jHeight: bigint, block: string, collateral: bigint, ondelta: bigint, nonce: bigint) => ({
      type: "j_event_claim" as const, jHeight, jBlockHash: jBlock(block), events: [settled(collateral, ondelta, nonce)], observedAt: 1n,
    });
    const clock = { timestamp: 1_700_000_000_123n, jHeight: 42n };
    const openReplica = unwrap(admit(unwrap(genesisReplica(id, terms)), [claim(7n, word("33"), 125n, 7n, 3n)]));
    const preview = unwrap(previewAccountProposal(openReplica, id.left, clock));
    const pending = unwrap(applyAccountBody(preview.draft.state, claim(8n, word("34"), 126n, 8n, 4n), { byLeft: true, nowMs: 1n, jHeight: 42n, accountHeight: preview.frame.height }));
    const root = unwrap(committed(pending.state)).view.leftPendingJClaims.root;
    expect(preview.frame.stateHash).toBe("0x11cbf8207b493f1595220c1d8760cfe3146ebbdbe298ed6b827c6c645919b5cc");
    expect(root).toBe("0x32a2477f6813fa0bdc1362166cf00922afe29372c9b0cf7a591095d9df31f2e1");
    expect(preview.frame.stateHash).not.toBe(root);
    expect(unwrap(committed(pending.state)).view.leftPendingJClaims.count).toBe(2n);
    expect(unwrap(committed(preview.draft.state)).view.rightPendingJClaims.root).toBe(EMPTY_J_ROOT);
  });

  test("two board signatures install the frame and one leaves it proposed", () => {
    const keys = [
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    ] as const;
    const signerAt = (key: string) => {
      const digest = new Uint8Array(32);
      const signed = signRaw(digest, hexToBytes(key));
      const raw = bytesToHex(concat([wordOf(signed.r), wordOf(signed.s), Uint8Array.of(signed.recovery + 27)]));
      const recovered = recoverRawSigner(bytesToHex(digest), raw);
      if (recovered === null) throw new Error("anvil address");
      return unwrap(address(recovered));
    };
    const signers = keys.map(signerAt);
    const peer = unwrap(entityId(word("bb")));
    const terms = unwrap(accountTerms({
      domain: { chainId: 1, depositoryAddress: `0x${"ab".repeat(20)}` },
      watchSeed: word("44"),
      disputeConfig: { leftResponseSeconds: 1, rightResponseSeconds: 1 },
    }));
    const board = {
      entityId: `0x${"00".repeat(31)}02`,
      votingThreshold: 2,
      entityIds: signers.map((signer) => `0x${"00".repeat(12)}${signer.slice(2)}`),
      votingPowers: [1, 1, 1],
      boardChangeDelay: 1,
      controlChangeDelay: 2,
      dividendChangeDelay: 3,
    };
    const jurisdictionConfig = { entityProviderAddress: `0x${"ee".repeat(20)}` };
    const lazyEntity = (b: typeof board) => {
      // og assertQuorumBoardBinding: the Entity signs as its lazy board id (the board hash, delays included)
      const id = unwrap(entityId(quorumBoardHash({ _tag: "board", board: b, entityId: b.entityId })));
      return { self: id, entity: unwrap(createEntity({ id, jurisdiction: terms.domain, board: b, jurisdictionConfig })) };
    };
    const delayed = lazyEntity(board);
    const delayedProposer = allowedProposer(delayed.entity.state.quorum);
    const openTx = { type: "openAccount" as const, data: { targetEntityId: peer, accountDomain: terms.domain, watchSeed: terms.watchSeed, disputeConfig: terms.disputeConfig } };
    // og resolveEntityCommandBoard hashes the config board with zero delays: a lazy id with delays is no command board, so og admission refuses
    const refusedByOg = ogAuthorVerdict(delayed.entity.state, delayedProposer, [openTx]);
    expect(refusedByOg).toStartWith("ENTITY_COMMAND_CERTIFIED_BOARD_REQUIRED:");
    const refused = applyEntityInput(delayed.entity, { kind: "txs", timestamp: 1n, txs: [openTx] }, { self: delayed.self, signerId: delayedProposer, verify: () => true, verifyMember: () => false, sign: crypto.sign });
    expect(refused.ok ? "ok" : "reason" in refused.error ? refused.error.reason : refused.error._tag).toBe(refusedByOg);
    const { self, entity } = lazyEntity({ ...board, boardChangeDelay: 0, controlChangeDelay: 0, dividendChangeDelay: 0 });
    const proposer = allowedProposer(entity.state.quorum);
    expect<string | undefined>(proposer.toLowerCase()).toBe(signers[0]?.toLowerCase());
    const raw = (index: number, digest: string) => {
      const key = keys[index];
      if (key === undefined) throw new Error("key");
      const signed = signRaw(hexToBytes(digest), hexToBytes(key));
      return unwrap(signature(bytesToHex(concat([wordOf(signed.r), wordOf(signed.s), Uint8Array.of(signed.recovery)])).slice(2)));
    };
    const sign = (digest: string, who: string) => ({ ok: true as const, value: raw(signers.findIndex((s) => s.toLowerCase() === who.toLowerCase()), digest) });
    const proposed = unwrap(applyEntityInput(entity, { kind: "txs", timestamp: 1n, txs: [openTx] }, {
      self, signerId: proposer, verify: () => true, verifyMember: () => false, sign,
    }));
    if (proposed.replica._tag !== "proposed") throw new Error(proposed.replica._tag);
    const frame = proposed.replica.frame;
    // og admission: the proposer's signed propose of the openAccount (one yes of the two the board needs)
    const ogTxs = ogAuthored(entity.state, proposer, [openTx]);
    expect<unknown[]>(frame.txs.map(wireEntityTx)).toEqual(ogTxs);
    const frameHash = unwrap(hashEntityFrame(frame));
    // the proposer's own manifest signature is one of two needed: the frame stays proposed
    expect(proposed.replica.signatures.get(proposer.toLowerCase())).toEqual(frame.hashesToSign.map((h) => raw(0, h.hash)));
    const precommit = (index: number) => ({ kind: "precommit" as const, height: frame.height, frameHash, signatures: new Map([[(signers[index] ?? "").toLowerCase(), frame.hashesToSign.map((h) => raw(index, h.hash))]]) });
    const bad = applyEntityInput(proposed.replica, { ...precommit(1), signatures: new Map([[(signers[1] ?? "").toLowerCase(), [raw(2, frameHash)]]]) }, {
      self, signerId: proposer, verify: () => true, verifyMember: () => false, sign,
    });
    expect(bad.ok).toBe(false);
    const two = unwrap(applyEntityInput(proposed.replica, precommit(1), {
      self, signerId: proposer, verify: () => true, verifyMember: () => false, sign,
    }));
    expect(two.replica._tag).toBe("open");
    // the installed frame commits og's pending proposal (and the proposer's nonce), not yet the Account
    const governance = ogAfterCommands(ogCommandState(entity.state, { timestamp: Number(frame.timestamp) }), ogTxs);
    expect(consensusBytes(two.replica.state.proposals)).toBe(consensusBytes(governance.proposals));
    expect(consensusBytes(ogOf(two.replica.state)["entityCommandNonces"])).toBe(consensusBytes(governance.entityCommandNonces));
    expect(two.replica.state.accounts.size).toBe(0);
  });
});

const open = (): { body: AccountBody; ctx: FoldCtx } => {
  const alice = unwrap(entityId(word("11")));
  const bob = unwrap(entityId(word("22")));
  const terms = unwrap(accountTerms({
    domain: { chainId: 1, depositoryAddress: `0x${"ab".repeat(20)}` },
    watchSeed: word("44"),
    disputeConfig: { leftResponseSeconds: 1, rightResponseSeconds: 1 },
  }));
  const ctx: FoldCtx = { byLeft: true, nowMs: 1n, jHeight: 0n, accountHeight: 1n };
  let body = genesisAccountBody(genesisAccount(unwrap(accountId(alice, bob))), terms);
  for (const tokenId of [T0, T1]) {
    body = unwrap(applyAccountBody(body, { type: "set_credit_limit", tokenId, limit: 20n }, ctx)).state;
    body = unwrap(applyAccountBody(body, { type: "set_credit_limit", tokenId, limit: 20n }, { ...ctx, byLeft: false })).state;
  }
  return { body, ctx };
};
