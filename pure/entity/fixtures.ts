// What the entity and runtime tests share: entities by number, a token, a judge, and the commands the tests send.
// Only tests import this.
import { expect } from "bun:test";
import { clockParams } from "../account/clause/clock.ts";
import { signing, tokenOf, viewOf } from "../account/fixtures.ts";
import type { Judge } from "../account/tx.ts";
import { unwrapOr } from "../kernel/core/result.ts";
import { heardOf, type Command, type EntityId, type Outbound, type PeerMessage } from "./model.ts";
import type { Anchor } from "./signing/signing.ts";

/** Entity number `n`: ids are ordered like their numbers, so the smaller number is the Left of an Account. */
export const entityOf = (n: number): EntityId => `0x${n.toString(16).padStart(64, "0")}` as EntityId;

export const GOLD = tokenOf(1n);

/** The one signature the entity tests' checker takes: these tests are not about keys (the signed-heads tests are). */
export const TEST_SIG = "0x7e57";

/** The proof a dispute the chain opened named: who authored it and the hash of its body. */
export const OPENED_WITH = { proposerIsLeft: true, bodyHash: `0x${"01".repeat(32)}` } as const;

/** Where the entity tests sign: the account tests' deployment and terms (each Account's key and epoch are its own). */
export const anchor: Anchor = {
  deployment: signing.deployment, terms: signing.terms, check: (_peer, _head, sig) => sig === TEST_SIG,
};

/** What the other Entity hears of an Outbound when its sender's Host has signed it, as the entity tests have it. */
export const heardSigned = (o: Outbound): PeerMessage => ({ ...heardOf(o), sig: TEST_SIG });

export const judge: Judge = {
  clock: unwrapOr(clockParams(1n, 2n, 10n), () => expect.unreachable("clock params")),
  view: viewOf(100n),
};

export const open = (peer: EntityId): Command => ({ _tag: "open_account", peer });
export const credit = (peer: EntityId, limit: bigint): Command => ({ _tag: "set_credit", peer, token: GOLD, limit });
export const pay = (peer: EntityId, amount: bigint): Command => ({ _tag: "pay", peer, token: GOLD, amount });
