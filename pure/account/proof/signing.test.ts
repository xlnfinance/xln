import { describe, expect, test } from "bun:test";
import { unwrapOr } from "../../kernel/core/result.ts";
import { deployment, accountKey } from "../../chain/proof/deployment.ts";
import { accountMessageHash } from "../../chain/proof/payload.ts";
import { proofBodyHash } from "../../chain/proof/proof.ts";
import { holdOf, tokenOf } from "../fixtures.ts";
import { emptyLedger } from "../ledger.ts";
import type { Side } from "../model.ts";
import { emptyAccount, withLedger } from "../state.ts";
import { proofBodyOf, type ProofTerms } from "./body.ts";
import { frameDigest, type SigningContext } from "./signing.ts";

const must = <T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T =>
  unwrapOr(r, (e) => expect.unreachable(JSON.stringify(e, (_, v) => (typeof v === "bigint" ? `${v}n` : v))));

const terms: ProofTerms = {
  watchSeed: `0x${"9b".repeat(32)}`, leftResponseSeconds: 60n, rightResponseSeconds: 60n,
  transformer: "0xbdf04ab3c4283b1531b8cf812ef21d4fed9be445", secondsOf: (d) => 1_000n + 12n * d,
};
const ctx: SigningContext = {
  deployment: must(deployment(11155111n, `0x${"ab".repeat(20)}`)),
  accountKey: must(accountKey(`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`)),
  ondeltaEpoch: 1n, firstNonce: 3n, terms,
};
const GOLD = tokenOf(1n);
const state = withLedger(emptyAccount, GOLD, { ...emptyLedger, offdelta: 5n, holds: [holdOf("left", 2n, 1n, 10n)] });
const digest = (c: SigningContext, height: number, author: "left" | "right", s = state) =>
  must(frameDigest(c, height, author, s));

describe("account/signing a committed frame is named by the digest its signers sign", () => {
  test("it is the dispute-proof message hash of the state's body, at the frame's nonce, by the frame's author", () => {
    const bodyHash = must(proofBodyHash(must(proofBodyOf(terms, state))));
    const message = (nonce: bigint, author: Side) => must(accountMessageHash(
      ctx.deployment, { accountKey: ctx.accountKey, ondeltaEpoch: 1n, nonce },
      { _tag: "dispute_proof", proposerIsLeft: author === "left", proofBodyHash: bodyHash, watchSeed: terms.watchSeed },
    ));
    expect(digest(ctx, 1, "left")).toBe(message(3n, "left"));
    expect(digest(ctx, 4, "right")).toBe(message(6n, "right"));
  });

  test("each of the height, the author, the epoch, the Account, the deployment and the state changes it", () => {
    const base = digest(ctx, 2, "left");
    const other = { ...state, ledgers: withLedger(state, GOLD, { ...emptyLedger, offdelta: 6n }).ledgers };
    const variants = [
      digest(ctx, 3, "left"), digest(ctx, 2, "right"), digest({ ...ctx, ondeltaEpoch: 2n }, 2, "left"),
      digest({ ...ctx, accountKey: must(accountKey(`0x${"11".repeat(32)}`, `0x${"23".repeat(32)}`)) }, 2, "left"),
      digest({ ...ctx, deployment: must(deployment(1n, `0x${"ab".repeat(20)}`)) }, 2, "left"),
      digest({ ...ctx, firstNonce: 10n }, 2, "left"), digest(ctx, 2, "left", other),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  test("two replicas that agree on the state and the context sign the same digest, with no input from the wire", () => {
    const again = { ...ctx, terms: { ...terms } };
    expect(digest(again, 2, "right")).toBe(digest(ctx, 2, "right"));
  });

  test("a frame number below the first, or not a whole number, has no digest: the baseline is unsigned", () => {
    expect(frameDigest(ctx, 0, "right", state)).toEqual({ ok: false, error: { _tag: "height_not_signed", height: 0 } });
    expect(frameDigest(ctx, -1, "left", state).ok).toBe(false);
    expect(frameDigest(ctx, 1.5, "left", state).ok).toBe(false);
  });

  test("a state that has no proof body has no digest: the refusal of the body is the refusal of the digest", () => {
    const stateless = { ...ctx, terms: { ...terms, secondsOf: () => 0n } };
    expect(frameDigest(stateless, 1, "left", state)).toEqual({
      ok: false, error: { _tag: "deadline_not_positive", seconds: 0n },
    });
  });
});
