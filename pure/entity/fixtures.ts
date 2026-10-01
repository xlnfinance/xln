// What the entity and runtime tests share: entities by number, a token, a judge, and the commands the tests send.
// Only tests import this.
import { expect } from "bun:test";
import { clockParams } from "../account/clause/clock.ts";
import { tokenOf, viewOf } from "../account/fixtures.ts";
import type { Judge } from "../account/tx.ts";
import { unwrapOr } from "../kernel/core/result.ts";
import type { Command, EntityId } from "./model.ts";

/** Entity number `n`: ids are ordered like their numbers, so the smaller number is the Left of an Account. */
export const entityOf = (n: number): EntityId => `0x${n.toString(16).padStart(64, "0")}` as EntityId;

export const GOLD = tokenOf(1n);

export const judge: Judge = {
  clock: unwrapOr(clockParams(1n, 2n, 10n), () => expect.unreachable("clock params")),
  view: viewOf(100n),
};

export const open = (peer: EntityId): Command => ({ _tag: "open_account", peer });
export const credit = (peer: EntityId, limit: bigint): Command => ({ _tag: "set_credit", peer, token: GOLD, limit });
export const pay = (peer: EntityId, amount: bigint): Command => ({ _tag: "pay", peer, token: GOLD, amount });
