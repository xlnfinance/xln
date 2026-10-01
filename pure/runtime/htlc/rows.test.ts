// What a Runtime hosting several Entities, or an Account holding several tokens, asks of the chain, and how the asks
// are stored and sent: the WAL row of an input is the only door to a chain action. Review B of PR 96: three mutants
// lived under Review A's tests: a hold looked up across tokens, the flush in reverse row order, and a row refused for
// an Entity the Runtime does not host that still carries a chain action (R-HTLC-CLOCK, R-DURABLE, R-X1).
import { describe, expect, test } from "bun:test";
import { emptyReplica, type AccountReplica } from "../../account/frame/account.ts";
import { hashlockOf, holdOf, secretOf, tokenOf, viewOf } from "../../account/fixtures.ts";
import { emptyLedger } from "../../account/ledger.ts";
import { emptyAccount, withLedger } from "../../account/state.ts";
import type { AccountState, Hold, TokenId } from "../../account/model.ts";
import type { AccountTx } from "../../account/tx.ts";
import { entityOf, GOLD, open } from "../../entity/fixtures.ts";
import { emptyEntity, type EntityId, type EntityState } from "../../entity/model.ts";
import { heightAt, inputFor, setup, tick } from "../fixtures.ts";
import { flush, recover, startRuntime } from "../tick.ts";

const SILVER = tokenOf(2n);
const ONE = entityOf(1);
const TWO = entityOf(2);
const PEER = entityOf(8);
const OTHER = entityOf(9);

const resolving = (token: TokenId, hold: Hold): AccountTx =>
  ({ _tag: "resolve", token, id: hold.id, secret: secretOf(Number(hold.id)) });

/** An Account whose payee (Right) holds `holds` by token and has resolved each, with no ack yet. */
const owing = (holds: readonly (readonly [TokenId, Hold])[]): AccountReplica => {
  const opened = (s: AccountState, [token, hold]: readonly [TokenId, Hold]): AccountState =>
    withLedger(s, token, { ...emptyLedger, holds: [...(s.ledgers.get(token)?.holds ?? []), hold] });
  const state = holds.reduce(opened, emptyAccount);
  return { ...emptyReplica("right"), state, mempool: holds.map(([token, hold]) => resolving(token, hold)) };
};

const entityOwing = (id: EntityId, byPeer: readonly (readonly [EntityId, AccountReplica])[]): EntityState =>
  ({ ...emptyEntity(id), accounts: new Map(byPeer) });

const hold = (id: bigint, deadline: bigint): Hold => holdOf("left", 30n, id, deadline);

const locks = (...ids: readonly bigint[]) => ids.map((id) => hashlockOf(secretOf(Number(id))));

const hashlocksOf = (chain: readonly { hashlock: string }[]) => chain.map((a) => a.hashlock);

const hosting = (entities: readonly EntityState[], view = 100n) =>
  startRuntime({ ...setup, view: viewOf(view) }, entities);

describe("runtime/rows what a Runtime asks of the chain is the actions of its rows, in row order", () => {
  const both = [
    entityOwing(TWO, [[PEER, owing([[GOLD, hold(2n, 115n)]])]]),
    entityOwing(ONE, [[PEER, owing([[GOLD, hold(1n, 115n)]])]]),
  ];

  test("R-DURABLE a flush after a crash asks for the rows in row order, each row's own actions in order", () => {
    const staggered = [
      entityOwing(ONE, [[PEER, owing([[GOLD, hold(1n, 116n)]])]]),
      entityOwing(TWO, [[PEER, owing([[GOLD, hold(2n, 115n)]])]]),
    ];
    const first = tick(hosting(staggered), heightAt(1n, 114n));
    const second = tick(first.runtime, heightAt(2n, 115n));
    expect([first.chain.length, second.chain.length]).toEqual([1, 1]);
    const crashed = { ...second.runtime, sent: 0 };
    expect(hashlocksOf(flush(crashed).chain.flatMap((a) => (a._tag === "reveal" ? [a] : [])))).toEqual(locks(2n, 1n));
  });

  test("R-X1 a row refused for an Entity the Runtime does not host asks nothing of the chain", () => {
    const stray = tick(hosting(both), inputFor(entityOf(7), 1n, open(PEER)));
    expect(stray.runtime.wal.at(-1)?.chain).toEqual([]);
    expect(stray.chain).toEqual([]);
  });
});

describe("runtime/rows an Account that holds several tokens is read in the token of the resolve", () => {
  test("R-HTLC-CLOCK a resolve names the hold of its own token: the same slot in another token is not it", () => {
    // Gold's hold in slot 1 is far from its deadline; Silver's hold in slot 1 (another secret) is due.
    const far = holdOf("left", 30n, 1n, 200n, 1);
    const near = holdOf("left", 30n, 1n, 115n, 2);
    const account = owing([[GOLD, far], [SILVER, near]]);
    const mempool = [{ ...resolving(SILVER, near), secret: secretOf(2) }];
    const due = tick(hosting([entityOwing(ONE, [[PEER, { ...account, mempool }]])]), heightAt(1n, 114n));
    expect(due.chain).toMatchObject([{ _tag: "reveal", token: SILVER, hashlock: hashlockOf(secretOf(2)) }]);
  });
});
