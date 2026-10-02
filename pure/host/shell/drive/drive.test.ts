// The Host's core, the WAL on a real file, and the submit path joined (R-DURABLE, R-FUND): an Entity is told to fund
// its reserve, the row is on the disk before the chain hears of it, the batch is journaled before it is sent, and a
// crash at any point comes back to the same one deposit. The chain is a port that answers what the scenario scripts and
// writes what it was asked to a log file, so the order of the calls is read from the file and nothing here mutates.
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { emptyEntity } from "../../../entity/model.ts";
import type { JAnswer } from "../../../j/batch/answer.ts";
import { err, ok, unwrapOr, type Result } from "../../../kernel/core/result.ts";
import { setup, stamp } from "../../../runtime/fixtures.ts";
import { limits } from "../../host.ts";
import { verifyHankoSignature } from "../../../chain/hanko/hanko-verify.ts";
import { credit, open } from "../../../entity/fixtures.ts";
import { addressOf, signDigest } from "../../../kernel/crypto/signature.ts";
import { ALICE, BOB, callsOf, DEPLOYED, GAS, journalIn, TREASURY, WORLD } from "../fixtures.ts";
import { GOLD } from "../../../runtime/fixtures.ts";
import { keyOf } from "../link/link.ts";
import type { ChainPort, PortFault } from "../submit/chain.ts";
import { lazySigner } from "../submit/signer.ts";
import { fileDisk } from "../node/file-disk.ts";
import { scanWal } from "../disk/wal.ts";
import { command, pump, start, type Boot, type Shell, type Turn } from "./drive.ts";

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

/** A chain that lands a batch as soon as it is sent, unless its sends are down. */
const portOf = (at: Scene, sends: Result<void, PortFault>): ChainPort => ({
  nonce: () => Promise.resolve(ok(4n)),
  treasury: () => Promise.resolve(ok(TREASURY)),
  simulate: () => {
    appendFileSync(at.log, "simulate\n");
    return Promise.resolve(ok({ _tag: "ok", applyGas: 100_000n }));
  },
  send: (call) => {
    const how = sends.ok ? "ok" : "lost";
    const held = journalIn(at.journal).join(",");
    appendFileSync(at.log, `send ${call.nonce} wal=${rowsIn(at).length} journal=${held} ${how}\n`);
    return Promise.resolve(sends);
  },
  answer: (batch) => {
    const landed = callsOf(at.log).some((c) => c.startsWith(`send ${batch.nonce} `) && c.endsWith(" ok"));
    const answer: JAnswer = { _tag: "landed", nonce: batch.nonce, batchHash: batch.digest, skipped: [] };
    return Promise.resolve(ok(landed ? answer : undefined));
  },
});

/** The shell over the scene's two files for one piece of work, and the files closed after it. */
const withShell = async <T>(
  at: Scene, sends: Result<void, PortFault>, work: (shell: Shell) => Promise<T>,
): Promise<T> => {
  appendFileSync(at.log, "");
  const wal = await fileDisk(at.wal);
  const journal = await fileDisk(at.journal);
  if (!wal.ok || !journal.ok) return expect.unreachable("disks");
  const io = { port: portOf(at, sends), signer: lazySigner(ALICE, KEY), journal: journal.value, gas: GAS };
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
});
