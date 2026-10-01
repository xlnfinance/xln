// Where an Entity signs each of its Accounts (R-FRAME-SIGNATURE-NAMES-ACCOUNT): its own key, the epoch and the first
// nonce the chain facts give it, so no two Accounts of one Entity, and no two epochs of one, sign the same bytes.
import { describe, expect, test } from "bun:test";
import { frameDigest } from "../../account/proof/signing.ts";
import { accountKey } from "../../chain/proof/deployment.ts";
import { entityFrame } from "../frame.ts";
import { freshChain } from "../chain.ts";
import { anchor, credit, entityOf, judge, open } from "../fixtures.ts";
import { emptyEntity, type ChainFacts, type EntityInput, type EntityState } from "../model.ts";
import { accountKeyOf, signingOf } from "./signing.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);
const CAROL = entityOf(3);

const run = (state: EntityState, ...inputs: readonly EntityInput[]) => entityFrame(judge, anchor, state, inputs);

const facts = (epoch: bigint, stored: bigint): ChainFacts => ({ ...freshChain, epoch, stored });

describe("entity/signing R-FRAME-SIGNATURE-NAMES-ACCOUNT an Account's context is read off its ids and facts", () => {
  test("the key is the Depository's: the two ids, the smaller first, whichever side asks", () => {
    const chainKey = accountKey(ALICE, BOB);
    expect(chainKey.ok && accountKeyOf(ALICE, BOB) === chainKey.value).toBe(true);
    expect(accountKeyOf(BOB, ALICE)).toBe(accountKeyOf(ALICE, BOB));
    expect(accountKeyOf(ALICE, CAROL)).not.toBe(accountKeyOf(ALICE, BOB));
  });

  test("the epoch is the chain's, and the first signed nonce is the stored nonce plus 2", () => {
    const c = signingOf(anchor, ALICE, BOB, facts(3n, 11n));
    expect([c.ondeltaEpoch, c.firstNonce]).toEqual([3n, 13n]);
    expect([c.deployment, c.terms]).toEqual([anchor.deployment, anchor.terms]);
    const fresh = signingOf(anchor, ALICE, BOB, freshChain);
    expect([fresh.ondeltaEpoch, fresh.firstNonce]).toEqual([0n, 2n]);
  });
});

describe("entity/signing R-FRAME-SIGNATURE-NAMES-ACCOUNT the Accounts of one Entity sign different bytes", () => {
  const both = run(emptyEntity(ALICE), open(BOB), open(CAROL));
  const proposed = run(both.state, credit(BOB, 50n), credit(CAROL, 50n)).state;
  const pendingOf = (peer: typeof BOB) =>
    proposed.accounts.get(peer)?.pending ?? expect.unreachable("nothing proposed");

  test("one credit to Bob and the same credit to Carol are the same frame, sealed under two keys", () => {
    const [toBob, toCarol] = [pendingOf(BOB), pendingOf(CAROL)];
    expect(toCarol.frame).toEqual(toBob.frame);
    expect(toCarol.head).not.toBe(toBob.head);
  });

  test("each head is the digest of the Account's own context at the epoch and nonce the facts give", () => {
    const sealed = (peer: typeof BOB) => {
      const p = pendingOf(peer);
      return frameDigest(signingOf(anchor, ALICE, peer, freshChain), p.frame.slot, "left", p.after);
    };
    expect([sealed(BOB), sealed(CAROL)].map((d) => d.ok && d.value))
      .toEqual([pendingOf(BOB).head, pendingOf(CAROL).head]);
  });

  test("the epoch and the stored nonce of an Account's facts move its digest", () => {
    const p = pendingOf(BOB);
    const at = (f: ChainFacts) => {
      const d = frameDigest(signingOf(anchor, ALICE, BOB, f), p.frame.slot, "left", p.after);
      return d.ok ? d.value : expect.unreachable("no digest");
    };
    expect(new Set([at(facts(0n, 0n)), at(facts(1n, 0n)), at(facts(0n, 4n))]).size).toBe(3);
  });
});
