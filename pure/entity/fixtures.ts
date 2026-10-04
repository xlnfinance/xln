// What the entity and runtime tests share: entities by number, a token, a judge, and the commands the tests send.
// Only tests import this.
import { expect } from "bun:test";
import { clockParams, jHeight } from "../account/clause/clock.ts";
import { signing, tokenOf, viewOf } from "../account/fixtures.ts";
import { holdId } from "../account/model.ts";
import type { Judge } from "../account/tx.ts";
import { unwrapOr } from "../kernel/core/result.ts";
import { keccakHex } from "../kernel/encoding/bytes.ts";
import { entityFrame } from "./frame.ts";
import {
  emptyEntity, heardOf, sideOf, type Command, type EntityId, type EntityInput, type EntityState, type Outbound,
  type PeerMessage,
} from "./model.ts";
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

/** What the Entities hold, by id; `to` is told `inputs` and every message that leaves any of them is told on. */
type Net = ReadonlyMap<EntityId, EntityState>;

const told = (view: bigint) => (net: Net, to: EntityId, inputs: readonly EntityInput[]): Net => {
  const at = { ...judge, view: viewOf(view) };
  const framed = entityFrame(at, anchor, net.get(to) ?? expect.unreachable("no entity"), inputs);
  const next = new Map([...net, [to, framed.state]]);
  return framed.outputs.reduce((acc: Net, out) => told(view)(acc, out.to, [heardSigned(out)]), next);
};

/** The secret whose hash the lock of `forwarded` is under. */
const FORWARDED_SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

/**
 * `hub` after `payer` locked 10 to it under `FORWARDED_SECRET` due at `deadline`, and it forwarded the lock to `next`,
 * which has not answered: an inbound hold on one Account, an outbound one on the other, and a `locked` paybook entry.
 * All at the J view `view`, which the lock's deadline must be near.
 */
export const forwarded = (
  hub: EntityId, payer: EntityId, next: EntityId, view: bigint, deadline: bigint,
): EntityState => {
  const tell = told(view);
  const ids = [hub, payer, next];
  const links = [[hub, payer], [payer, hub], [hub, next], [next, hub]] as const;
  const bare: Net = new Map(ids.map((id) => [id, emptyEntity(id)]));
  const opened = links.reduce((net, [self, peer]) => tell(net, self, [open(peer)]), bare);
  const credited = links.reduce((net, [self, peer]) => tell(net, self, [credit(peer, 1000n)]), opened);
  const hashlock = keccakHex(FORWARDED_SECRET);
  const routed = tell(credited, hub, [{ _tag: "forward", hashlock, from: payer, to: next }]);
  const hold = {
    id: holdId(1n), payer: sideOf(payer, hub), amount: 10n, hashlock,
    deadline: unwrapOr(jHeight(deadline), () => expect.unreachable("deadline")),
  };
  const locked = tell(routed, payer, [{ _tag: "lock", peer: hub, token: GOLD, hold }]);
  return locked.get(hub) ?? expect.unreachable("no hub");
};
