// The Host's core, the WAL on a real file, and the submit path joined (R-DURABLE, R-FUND): an Entity is told to fund
// its reserve, the row is on the disk before the chain hears of it, the batch is journaled before it is sent, and a
// crash at any point comes back to the same one deposit. The chain is a port that answers what the scenario scripts and
// writes what it was asked to a log file, so the order of the calls is read from the file and nothing here mutates.
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { encodeBatch } from "../../../chain/batch/batch.ts";
import { emptyEntity } from "../../../entity/model.ts";
import type { JAnswer, SkipFact } from "../../../j/batch/answer.ts";
import { MIN_GAS_BUDGET } from "../../../j/batch/sealed.ts";
import { assemble } from "../../../j/op/assemble.ts";
import type { Cause, Simulation } from "../../../j/gas/simulate.ts";
import { err, ok, unwrapOr, type Result } from "../../../kernel/core/result.ts";
import { hostOf, setup, stamp } from "../../../runtime/fixtures.ts";
import { limits } from "../../host.ts";
import { verifyHankoSignature } from "../../../chain/hanko/hanko-verify.ts";
import { credit, open } from "../../../entity/fixtures.ts";
import { addressOf, signDigest } from "../../../kernel/crypto/signature.ts";
import { ALICE, aliceRun, BOB, callsOf, DEPLOYED, GAS, journalIn, TREASURY, WORLD } from "../fixtures.ts";
import { GOLD } from "../../../runtime/fixtures.ts";
import { keyOf } from "../link/link.ts";
import type { ChainPort, PortFault } from "../submit/chain.ts";
import { lazySigner } from "../submit/signer.ts";
import { fileDisk } from "../node/file-disk.ts";
import { scanWal } from "../disk/wal.ts";
import { heightOf } from "../../../account/fixtures.ts";
import { command, observe, pump, start, type Boot, type Shell, type Turn } from "./drive.ts";

const KEY = unwrapOr(keyOf(Uint8Array.from({ length: 32 }, (_, i) => i + 1)), () => expect.unreachable("key"));
const BOOT: Boot = {
  setup, genesis: emptyEntity(ALICE), where: { entity: ALICE, deployment: DEPLOYED, world: WORLD },
  limits: unwrapOr(limits(8, 8), () => expect.unreachable("limits")),
};
const FUND = { _tag: "fund", token: GOLD, amount: 25n } as const;

type Scene = Readonly<{ wal: string; journal: string; log: string }>;

const scene = (): Scene => {
  const dir = mkdtempSync(`${tmpdir()}/drive-`);
  return { wal: `${dir}/wal.log`, journal: `${dir}/journal.log`, log: `${dir}/calls.log` };
};

const rowsIn = (at: Scene) => {
  const scanned = scanWal(readFileSync(at.wal));
  return scanned.ok ? scanned.value.rows : expect.unreachable("wal damaged");
};

const DOWN: PortFault = { _tag: "port", call: "send", reason: "connection reset" };

/** The batch of no op the Host simulates before it gives a counter up: what the chain says of it is the batch's own. */
const BARE = unwrapOr(encodeBatch(assemble(MIN_GAS_BUDGET, [])), () => expect.unreachable("no bare batch"));
const LANDS: Simulation["outcome"] = { _tag: "ok", applyGas: 100_000n };

/** A chain that lands a batch as soon as it is sent, unless its sends are down. */
const portOf = (
  at: Scene, sends: Result<void, PortFault>, outcome: Simulation["outcome"] = LANDS, skipReason?: number,
  bare: Simulation["outcome"] = LANDS,
): ChainPort => ({
  nonce: () => Promise.resolve(ok(4n)),
  treasury: () => Promise.resolve(ok(TREASURY)),
  simulate: (call) => {
    appendFileSync(at.log, "simulate\n");
    return Promise.resolve(ok(call.encodedBatch === BARE ? bare : outcome));
  },
  send: (call) => {
    const how = sends.ok ? "ok" : "lost";
    const held = journalIn(at.journal).join(",");
    appendFileSync(at.log, `send ${call.nonce} wal=${rowsIn(at).length} journal=${held} ${how}\n`);
    return Promise.resolve(sends);
  },
  answer: (batch) => {
    const landed = callsOf(at.log).some((c) => c.startsWith(`send ${batch.nonce} `) && c.endsWith(" ok"));
    const skipped = skipReason === undefined ? [] : batch.ops.flatMap((op): SkipFact[] => {
      if (op._tag === "dispute_start") {
        return [{ op: 0, counterentity: op.start.counterentity, reason: skipReason, nonce: op.start.nonce }];
      }
      return op._tag === "dispute_counter"
        ? [{ op: 1, counterentity: op.counter.counterentity, reason: skipReason, nonce: op.counter.counterNonce }]
        : [];
    });
    const answer: JAnswer = { _tag: "landed", nonce: batch.nonce, batchHash: batch.digest, skipped };
    return Promise.resolve(ok(landed ? answer : undefined));
  },
});

/** The shell over the scene's two files for one piece of work, and the files closed after it. */
/** The simulation the scene's port answers with when a test names none. */
const DEFAULT_OUTCOME: Simulation["outcome"] | undefined = undefined;
const NO_SKIP: number | undefined = undefined;

const withShell = async <T>(
  at: Scene, sends: Result<void, PortFault>, work: (shell: Shell) => Promise<T>,
  outcome?: Simulation["outcome"], skipReason?: number, bare?: Simulation["outcome"],
): Promise<T> => {
  appendFileSync(at.log, "");
  const wal = await fileDisk(at.wal);
  const journal = await fileDisk(at.journal);
  if (!wal.ok || !journal.ok) return expect.unreachable("disks");
  const port = portOf(at, sends, outcome, skipReason, bare);
  const io = { port, signer: lazySigner(ALICE, KEY), journal: journal.value, gas: GAS };
  const out = await work({ wal: wal.value, io, now: () => stamp(1_000n) });
  await wal.value.close();
  await journal.value.close();
  return out;
};

const shown = (error: unknown): string => JSON.stringify(error, (_, v) => (typeof v === "bigint" ? v.toString() : v));

const turnOf = (r: Result<Turn, unknown>): Turn => (r.ok ? r.value : expect.unreachable(shown(r.error)));

describe("host/shell/drive the Host's rows are on the disk before the chain hears of them", () => {
  test("R-FUND a fund command is a WAL row, a sealed batch, a send and a landed answer, in that order", async () => {
    const at = scene();
    const turn = await withShell(at, ok(undefined), async (shell) => {
      const started = turnOf(await start(shell, BOOT));
      const asked = turnOf(await command(shell, started.station, ALICE, FUND));
      expect(journalIn(at.journal)).toEqual(["sealed@5"]);
      return turnOf(await pump(shell, asked));
    });
    expect(turn.taken.map((t) => t._tag)).toEqual(["queued"]);
    expect(rowsIn(at).map((r) => r.chain.map((a) => a._tag))).toEqual([["fund"]]);
    expect(callsOf(at.log)).toEqual(["simulate", "simulate", "send 5 wal=1 journal=sealed@5 ok"]);
    expect(journalIn(at.journal)).toEqual(["sealed@5", "answered@5"]);
    expect(turn.station.submitter.waiting.size).toBe(0);
  });

  test("R-DURABLE a lost send and a restart ask the chain for the same batch again, not a second deposit", async () => {
    const at = scene();
    await withShell(at, err(DOWN), async (shell) => {
      const started = turnOf(await start(shell, BOOT));
      return turnOf(await command(shell, started.station, ALICE, FUND));
    });
    expect(journalIn(at.journal)).toEqual(["sealed@5"]);
    const back = await withShell(at, ok(undefined), async (shell) => {
      const restarted = turnOf(await start(shell, BOOT));
      return turnOf(await pump(shell, restarted));
    });
    expect(callsOf(at.log).filter((c) => c.startsWith("send"))).toEqual([
      "send 5 wal=1 journal=sealed@5 lost", "send 5 wal=1 journal=sealed@5 ok",
    ]);
    expect(journalIn(at.journal)).toEqual(["sealed@5", "answered@5"]);
    expect(back.taken.map((t) => t._tag)).toEqual(["known"]);
    expect(rowsIn(at)).toHaveLength(1);
  });

  test("R-DURABLE a restart after the batch landed asks nothing of the chain at all", async () => {
    const at = scene();
    await withShell(at, ok(undefined), async (shell) => {
      const started = turnOf(await start(shell, BOOT));
      return turnOf(await pump(shell, turnOf(await command(shell, started.station, ALICE, FUND))));
    });
    const before = callsOf(at.log);
    const back = await withShell(at, ok(undefined), async (shell) => turnOf(await start(shell, BOOT)));
    expect(callsOf(at.log)).toEqual(before);
    expect(back.taken.map((t) => t._tag)).toEqual(["known"]);
  });

  test("R-FUND a fund of a token the chain world does not list is named and nothing is sealed or sent", async () => {
    const at = scene();
    const unlisted = { ...FUND, token: 9n as typeof GOLD };
    const turn = await withShell(at, ok(undefined), async (shell) => {
      const started = turnOf(await start(shell, BOOT));
      return turnOf(await command(shell, started.station, ALICE, unlisted));
    });
    expect(turn.taken).toEqual([{ _tag: "unknown_token", token: 9n }]);
    expect(callsOf(at.log)).toEqual([]);
    expect(journalIn(at.journal)).toEqual([]);
  });

  test("R-DURABLE a WAL that cannot be written asks nothing of the chain and says so", async () => {
    const at = scene();
    const out = await withShell(at, ok(undefined), async (shell) => {
      const started = turnOf(await start(shell, BOOT));
      const full = () => Promise.resolve(err({ _tag: "disk", op: "sync", reason: "no space" } as const));
      const dead = { ...shell, wal: { ...shell.wal, run: full } };
      return command(dead, started.station, ALICE, FUND);
    });
    expect(out).toMatchObject({ ok: false, error: { _tag: "disk" } });
    expect(callsOf(at.log)).toEqual([]);
  });

  test("R-SIGNED-HEADS-ON-THE-WIRE a frame a restart flushes leaves signed, same signature", async () => {
    const at = scene();
    const first = await withShell(at, ok(undefined), async (shell) => {
      const started = turnOf(await start(shell, BOOT));
      const opened = turnOf(await command(shell, started.station, ALICE, open(BOB)));
      return turnOf(await command(shell, opened.station, ALICE, credit(BOB, 50n)));
    });
    const back = await withShell(at, ok(undefined), async (shell) => turnOf(await start(shell, BOOT)));
    const signer = addressOf(signDigest(Uint8Array.from({ length: 32 }, () => 1), KEY.secret).publicKey).toLowerCase();
    const named = (turn: Turn) => turn.sent.filter((m) => m.attest !== undefined);
    expect(named(first)).toHaveLength(1);
    expect(named(back).map((m) => m.sig)).toEqual(named(first).map((m) => m.sig));
    [...named(first), ...named(back)].forEach((m) => {
      const verdict = verifyHankoSignature(m.sig ?? "", m.attest ?? "", () => ok(true));
      expect(verdict.ok && verdict.value.signers).toEqual([signer]);
      expect(verdict.ok && verdict.value.entityId).toBe(ALICE);
    });
  });

  test("R-DISPUTE-LAPSED a start the chain would revert is dropped and the Entity may ask again", async () => {
    const at = scene();
    const paid = hostOf(aliceRun, ALICE).entities.get(ALICE) ?? expect.unreachable("no entity");
    const dispute = { _tag: "dispute", peer: BOB } as const;
    const facts = (turn: Turn) => turn.station.host.runtime.entities.get(ALICE)?.chain.get(BOB);
    const out = await withShell(at, ok(undefined), async (shell) => {
      const started = turnOf(await start(shell, { ...BOOT, genesis: paid }));
      const first = turnOf(await command(shell, started.station, ALICE, dispute));
      return { first, second: turnOf(await command(shell, first.station, ALICE, dispute)) };
    }, { _tag: "reverts", reason: "bad signature", causes: [] });
    expect(out.first.lapsed.map((op) => op._tag)).toEqual(["dispute_start"]);
    expect(facts(out.first)?.starting).toBeUndefined();
    expect(out.first.station.submitter.jbatch.draft).toEqual([]);
    expect(callsOf(at.log).filter((c) => c.startsWith("send"))).toEqual([]);
    expect(out.second.lapsed.map((op) => op._tag)).toEqual(["dispute_start"]);
    expect(rowsIn(at).map((r) => r.notices.map((n) => n._tag))).toEqual([[], [], [], []]);
    expect(rowsIn(at).flatMap((r) => r.chain.map((a) => a._tag))).toEqual(["dispute_start", "dispute_start"]);
  });

  const counterOpened = {
    _tag: "j_dispute", peer: BOB, epoch: 0n, by: "right", nonce: 1n, timeout: 500n, proposerIsLeft: false,
    bodyHash: `0x${"01".repeat(32)}`,
  } as const;
  const answerOf = (turn: Turn) => turn.station.host.runtime.entities.get(ALICE)?.chain.get(BOB)?.against?.answer;
  const counterTurns = async (outcome: Simulation["outcome"], skipReason?: number, bare?: Simulation["outcome"]) => {
    const at = scene();
    const paid = hostOf(aliceRun, ALICE).entities.get(ALICE) ?? expect.unreachable("no entity");
    const out = await withShell(at, ok(undefined), async (shell) => {
      const started = turnOf(await start(shell, { ...BOOT, genesis: paid }));
      const first = turnOf(await command(shell, started.station, ALICE, counterOpened));
      const second = turnOf(await command(shell, first.station, ALICE, { _tag: "resend_due", peer: BOB }));
      return { first, second, third: turnOf(await pump(shell, second)) };
    }, outcome, skipReason, bare);
    return { at, ...out };
  };
  const E4: Cause = { _tag: "error", name: "E4" };

  test("R-DISPUTE-LAPSED a counter the chain would revert is dropped and not asked for again", async () => {
    const out = await counterTurns({ _tag: "reverts", reason: "window over", causes: [E4] });
    expect(out.first.lapsed.map((op) => op._tag)).toEqual(["dispute_counter"]);
    expect(answerOf(out.first)?.lapsed).toBe(true);
    expect(out.first.station.submitter.jbatch.draft).toEqual([]);
    expect(callsOf(out.at.log).filter((c) => c.startsWith("send"))).toEqual([]);
    expect(out.second.lapsed).toEqual([]);
    expect(rowsIn(out.at).flatMap((r) => r.chain.map((a) => a._tag))).toEqual(["counter"]);
  });

  test("R-HEIGHT-ORDER a dropped observation counter feeds back only after the delivery is durable", async () => {
    const at = scene();
    const paid = hostOf(aliceRun, ALICE).entities.get(ALICE) ?? expect.unreachable("no entity");
    const boot = { ...BOOT, genesis: paid, limits: unwrapOr(limits(8, 1), () => expect.unreachable("limits")) };
    const outcome: Simulation["outcome"] = { _tag: "reverts", reason: "window over", causes: [E4] };
    const first = await withShell(at, ok(undefined), async (shell) => {
      const started = turnOf(await start(shell, boot));
      return turnOf(await observe(shell, started.station, ALICE, [counterOpened], heightOf(501n)));
    }, outcome);
    expect(first.lapsed.map((op) => op._tag)).toEqual(["dispute_counter"]);
    expect(answerOf(first)?.lapsed).toBe(true);
    expect(first.station.host.runtime.view).toBe(501n as never);
    const rows = rowsIn(at);
    expect(rows.map((r) => r.input._tag)).toEqual(["j_observation", "entity"]);
    expect(rows[0]?.chain.map((a) => a._tag)).toEqual(["counter", "counter"]);
    expect(first.taken.map((t) => t._tag)).toEqual(["queued", "skipped"]);
    const back = await withShell(at, ok(undefined), async (shell) => turnOf(await start(shell, boot)), outcome);
    expect(answerOf(back)?.lapsed).toBe(true);
    expect(back.station.host.runtime.entities).toEqual(first.station.host.runtime.entities);
    expect(callsOf(at.log).filter((c) => c.startsWith("send"))).toEqual([]);
  });

  test("R-DISPUTE-LAPSED a counter is not given up while the chain refuses a batch of no op at its nonce", async () => {
    const reverts: Simulation["outcome"] = { _tag: "reverts", reason: "window over", causes: [E4] };
    const out = await counterTurns(reverts, NO_SKIP, reverts);
    expect(out.first.lapsed).toEqual([]);
    expect(answerOf(out.first)?.lapsed).toBe(false);
    expect(out.first.station.submitter.jbatch.draft).toEqual([]);
    expect(rowsIn(out.at).flatMap((r) => r.chain.map((a) => a._tag))).toEqual(["counter", "counter"]);
  });

  test("R-DISPUTE-LAPSED a counter held for a reason that can heal is asked for again", async () => {
    const transient: Cause[] = [{ _tag: "error", name: "E3" }];
    const out = await counterTurns({ _tag: "reverts", reason: "execution failed", causes: transient });
    expect(out.first.lapsed).toEqual([]);
    expect(answerOf(out.first)?.lapsed).toBe(false);
    expect(out.first.station.submitter.jbatch.draft).toEqual([]);
    expect(out.second.lapsed).toEqual([]);
    expect(answerOf(out.second)?.lapsed).toBe(false);
    expect(rowsIn(out.at).flatMap((r) => r.chain.map((a) => a._tag))).toEqual(["counter", "counter"]);
  });

  test("R-DISPUTE-LAPSED a counter whose revert the Host cannot name is not given up either", async () => {
    const out = await counterTurns({ _tag: "reverts", reason: "execution failed", causes: [] });
    expect(out.first.lapsed).toEqual([]);
    expect(answerOf(out.first)?.lapsed).toBe(false);
  });

  test("R-DISPUTE-LAPSED a counter skipped for good in a landed batch lapses, one that can heal does not", async () => {
    const skipped = (reason: number): Simulation["outcome"] =>
      ({ _tag: "reverts", reason: "DisputeOpSkipped", causes: [{ _tag: "skipped", op: 1, reason }] });
    const closed = await counterTurns(skipped(4));
    expect(closed.first.lapsed.map((op) => op._tag)).toEqual(["dispute_counter"]);
    const none = await counterTurns(skipped(2));
    expect([none.first.lapsed, answerOf(none.first)?.lapsed]).toEqual([[], false]);
  });
  /** A start the chain's simulation passed and its batch landed, then skipped for `reason`: what the Entity is told. */
  const startSkipped = async (reason: number) => {
    const at = scene();
    const paid = hostOf(aliceRun, ALICE).entities.get(ALICE) ?? expect.unreachable("no entity");
    const dispute = { _tag: "dispute", peer: BOB } as const;
    const out = await withShell(at, ok(undefined), async (shell) => {
      const started = turnOf(await start(shell, { ...BOOT, genesis: paid }));
      return turnOf(await pump(shell, turnOf(await command(shell, started.station, ALICE, dispute))));
    }, DEFAULT_OUTCOME, reason);
    return { at, out, starting: out.station.host.runtime.entities.get(ALICE)?.chain.get(BOB)?.starting };
  };

  test("R-DISPUTE-LAPSED a start skipped for good (nonce reached, epoch left) is told as lapsed", async () => {
    const [reached, left] = [await startSkipped(0), await startSkipped(11)];
    expect(reached.out.skipped.map(({ op, reason }) => [op._tag, reason])).toEqual([["dispute_start", 0]]);
    expect([reached.starting, left.starting]).toEqual([undefined, undefined]);
  });

  test("R-DISPUTE-LAPSED a start skipped because a dispute is open stays: it may be its own, restated", async () => {
    const open = await startSkipped(1);
    expect(open.out.skipped.map(({ reason }) => reason)).toEqual([1]);
    expect(open.starting).toBeDefined();
  });
  test("R-DISPUTE-LAPSED a counter that landed and was skipped for good lapses, an unknown skip does not", async () => {
    const ok_: Simulation["outcome"] = { _tag: "ok", applyGas: 100_000n };
    const [window, none] = [await counterTurns(ok_, 4), await counterTurns(ok_, 2)];
    expect([answerOf(window.third)?.lapsed, answerOf(none.third)?.lapsed]).toEqual([true, false]);
  });
});
