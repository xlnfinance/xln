// Real WALs for the shell's tests: the rows of Runtimes that ran, so a codec or a disk is judged on what the Runtime
// writes, with bigints, bytes and absent fields, and not on rows made up for it.
import { expect } from "bun:test";
import { holdOf, secretOf, viewOf } from "../../account/fixtures.ts";
import { holdId } from "../../account/model.ts";
import { deployment } from "../../chain/proof/deployment.ts";
import type { Command } from "../../entity/model.ts";
import { unwrapOr } from "../../kernel/core/result.ts";
import {
  type Cluster, credit, entityOf, feed, GOLD, hostOf, open, pay, rise, settle, start,
} from "../../runtime/fixtures.ts";
import type { Row } from "../../runtime/model.ts";
import type { ChainWorld } from "../ops.ts";
import type { Asked } from "./submit/submit.ts";

export const ALICE = entityOf(1);
export const BOB = entityOf(2);

const opened = settle(feed(feed(start(viewOf(110n), viewOf(110n)), ALICE, open(BOB)), BOB, open(ALICE)));
const credited = settle(feed(opened, BOB, credit(ALICE, 100n)));
const paid = settle(feed(credited, ALICE, pay(BOB, 10n)));
const deposit: Command = { _tag: "deposit", peer: BOB, token: GOLD, amount: 10n };
const lockIn: Command = { _tag: "lock", peer: BOB, token: GOLD, hold: holdOf("left", 30n, 1n, 115n, 1) };
const resolve: Command = { _tag: "resolve", peer: ALICE, token: GOLD, id: holdId(1n), secret: secretOf(1) };

/** Alice's Runtime after opening, credit, a payment and a deposit: bigints and an ask of the chain. */
export const aliceRun: Cluster = feed(paid, ALICE, deposit);

/** Bob's Runtime after a resolve whose ack never came and a J height near the deadline: a reveal, secret in bytes. */
export const bobRun: Cluster = rise(feed(settle(feed(credited, ALICE, lockIn)), BOB, resolve), BOB, 114n);

export const walOf = (run: Cluster, id: typeof ALICE): readonly Row[] => hostOf(run, id).wal;

/** The deployed Depository the J path signs for, and the one transformer a reveal may name. */
export const DEPLOYED = unwrapOr(
  deployment(11155111n, "0x1111111111111111111111111111111111111111"),
  () => expect.unreachable("deployment"),
);
export const WORLD: ChainWorld = {
  transformer: "0x2222222222222222222222222222222222222222",
  tokens: new Map([[1n, { contractAddress: `0x${"33".repeat(20)}`, externalTokenId: 0n, tokenType: 0n }]]),
};

/** The chain's transaction gas cap and the outer Hanko check, as the harness sets them. */
export const GAS = { txGasCap: 16_777_216n, prelude: 200_000n };

/** What Alice holds on chain for the funded check: 100 of the one token, no debt. */
export const TREASURY = new Map([[1n, { reserve: 100n, debt: 0n }]]);

/** Alice's deposit as the Runtime asks for it: the action and the row it was committed in. */
export const DEPOSIT: Asked = (() => {
  const row = walOf(aliceRun, ALICE).findLast((r) => r.chain.some((a) => a._tag === "deposit")) as Row;
  const index = row.chain.findIndex((a) => a._tag === "deposit");
  return { action: row.chain[index] as Asked["action"], row: { height: row.height, index } };
})();
