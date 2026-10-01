// Real WALs for the shell's tests: the rows of Runtimes that ran, so a codec or a disk is judged on what the Runtime
// writes, with bigints, bytes and absent fields, and not on rows made up for it.
import { holdOf, secretOf, viewOf } from "../../account/fixtures.ts";
import { holdId } from "../../account/model.ts";
import type { Command } from "../../entity/model.ts";
import {
  type Cluster, credit, entityOf, feed, GOLD, hostOf, open, pay, rise, settle, start,
} from "../../runtime/fixtures.ts";
import type { Row } from "../../runtime/model.ts";

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
