// Real WALs for the shell's tests: the rows of Runtimes that ran, so a codec or a disk is judged on what the Runtime
// writes, with bigints, bytes and absent fields, and not on rows made up for it.
import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import type { FrameHash } from "../../account/frame/frame.ts";
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
import { scanJournal } from "./submit/journal.ts";
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

/** Alice's Runtime after she asked to dispute the Account with Bob from the head of the payment. */
const aliceDisputed: Cluster = feed(paid, ALICE, { _tag: "dispute", peer: BOB });

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

/** Alice's dispute start as the Runtime asks for it: the action and the row it was committed in. */
export const START: Asked = (() => {
  const row = walOf(aliceDisputed, ALICE).findLast((r) => r.chain.some((a) => a._tag === "dispute_start")) as Row;
  const index = row.chain.findIndex((a) => a._tag === "dispute_start");
  return { action: row.chain[index] as Asked["action"], row: { height: row.height, index } };
})();

/** A counter to a dispute, as the Runtime asks for it: the opening body again, a nonce above the start's, a signature. */
export const COUNTER: Asked = (() => {
  const start = START.action._tag === "dispute_start" ? START.action : expect.unreachable("not a start");
  const action: Asked["action"] = {
    _tag: "counter", peer: start.peer, nonce: start.nonce + 1n, head: `0x${"07".repeat(32)}` as FrameHash,
    proposerIsLeft: start.proposerIsLeft, body: start.body, sig: `0x${"11".repeat(65)}`,
    initial: { nonce: start.nonce, bodyHash: `0x${"09".repeat(32)}` },
  };
  return { action, row: { height: START.row.height + 200n, index: 0 } };
})();

/** A finalize of the dispute START opened, with the opening proof, as the Runtime asks for it. */
export const FINALIZE: Asked = (() => {
  const start = START.action._tag === "dispute_start" ? START.action : expect.unreachable("not a start");
  const action: Asked["action"] = {
    _tag: "dispute_finalize", peer: start.peer, nonce: start.nonce, proposerIsLeft: start.proposerIsLeft,
    body: start.body, startedByLeft: true, initial: undefined,
  };
  return { action, row: { height: START.row.height + 300n, index: 0 } };
})();

/** What a scripted chain port wrote about the calls it got, one line each. */
export const callsOf = (path: string): readonly string[] =>
  readFileSync(path, "utf8").split("\n").filter((l) => l !== "");

/** The records a journal file holds, as `kind@nonce`. */
export const journalIn = (path: string): readonly string[] => {
  const kept = scanJournal(readFileSync(path));
  return kept.ok ? kept.value.items.map((r) => `${r._tag}@${r.nonce}`) : [`damaged ${kept.error._tag}`];
};
