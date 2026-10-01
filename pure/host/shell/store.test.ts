// The WAL on a disk: a row is kept only when its record is synced, a crash at any byte of the last record leaves the
// rows before it, and what comes back from a real file is a Runtime that replays (R-DURABLE).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { err, ok } from "../../kernel/core/result.ts";
import { emptyEntity } from "../../entity/model.ts";
import type { Row } from "../../runtime/model.ts";
import { reopen } from "../host.ts";
import { BOUNDS, unhalted } from "../fixtures.ts";
import { type Disk, type DiskOp, failStop, sequence } from "./disk.ts";
import { fileDisk } from "./node/file-disk.ts";
import { aliceRun, ALICE, bobRun, BOB, walOf } from "./fixtures.ts";
import { appendOps, keep, openWal } from "./store.ts";
import { recordOf } from "./wal.ts";

const rows = walOf(aliceRun, ALICE);
const last = rows[rows.length - 1] as Row;

const scratch = (): string => {
  const dir = mkdtempSync(`${tmpdir()}/wal-`);
  return `${dir}/wal.log`;
};

const opened = async (path: string): Promise<Disk> => {
  const disk = await fileDisk(path);
  return disk.ok ? disk.value : expect.unreachable("fileDisk");
};

/** The rows kept one after another through a real file, and the file closed. */
const written = async (path: string, of: readonly Row[]): Promise<void> => {
  const disk = await opened(path);
  const keepAfter = (before: Promise<unknown>, row: Row) => before.then(() => keep(disk, row));
  const done = await of.reduce<Promise<unknown>>(keepAfter, Promise.resolve());
  expect(done).toEqual(ok(undefined));
  await disk.close();
};

const readBack = async (path: string) => {
  const disk = await opened(path);
  const back = await openWal(disk);
  await disk.close();
  return back;
};

describe("host/shell/store a row is kept as one record then a sync, and reported only when both are done", () => {
  test("R-DURABLE the operations that make a row durable are its record, then a sync, in that order", () => {
    const ops = appendOps(last);
    const record = recordOf(last);
    const bytes = record.ok ? record.value : expect.unreachable("record");
    expect(ops).toEqual({ ok: true, value: [{ _tag: "write", bytes }, { _tag: "sync" }] });
  });

  test("R-DURABLE keep is not done until the disk says so, and the disk sees write then sync", async () => {
    const gate = Promise.withResolvers<void>();
    const seen = Promise.withResolvers<readonly DiskOp["_tag"][]>();
    const disk: Disk = {
      read: () => Promise.resolve(ok(new Uint8Array())),
      run: (ops) => gate.promise.then(() => {
        seen.resolve(ops.map((op) => op._tag));
        return ok(undefined);
      }),
      close: () => Promise.resolve(ok(undefined)),
    };
    const kept = keep(disk, last);
    const early = await Promise.race([kept.then(() => "done"), Promise.resolve("waiting").then((x) => x)]);
    expect(early).toBe("waiting");
    gate.resolve();
    expect(await kept).toEqual(ok(undefined));
    expect(await seen.promise).toEqual(["write", "sync"]);
  });

  test("R-DURABLE a sync is never run before the write it covers, and nothing runs after a fault", async () => {
    const ops: readonly DiskOp[] = [{ _tag: "write", bytes: new Uint8Array(1) }, { _tag: "sync" }, { _tag: "sync" }];
    const trails = await sequence(ops, (op, done) => Promise.resolve(
      op._tag === "sync" && done.length === 0
        ? err({ _tag: "disk", op: "sync", reason: "sync before write" })
        : ok(undefined)));
    expect(trails).toEqual(ok(undefined));
    const faulting = await sequence(ops, (op, done) => Promise.resolve(
      (done.length === 1 ? err({ _tag: "disk", op: op._tag, reason: "full" }) : ok(undefined))));
    expect(faulting).toEqual({ ok: false, error: { _tag: "disk", op: "sync", reason: "full" } });
  });

  test("a row that has no exact text is not kept, and nothing reaches the disk", async () => {
    const disk = await opened(scratch());
    const kept = await keep(disk, Object.assign({}, last, { notices: [new Map()] }));
    expect(kept).toMatchObject({ ok: false, error: { _tag: "unwritable" } });
    await disk.close();
  });
});

describe("host/shell/store what a file gives back after a crash", () => {
  test("R-DURABLE the rows kept come back, in order, from a file opened again", async () => {
    const path = scratch();
    await written(path, rows);
    expect(await readBack(path)).toEqual(ok(rows));
  });

  test("R-DURABLE a crash inside the last record leaves the rows before it, and the file is cut", async () => {
    const path = scratch();
    await written(path, rows.slice(0, -1));
    const priorBytes = readFileSync(path);
    const record = recordOf(last);
    const finalBytes = record.ok ? record.value : expect.unreachable("record");
    const cuts = [1, 3, 4, 5, 17, Math.floor(finalBytes.length / 2), finalBytes.length - 9, finalBytes.length - 1];
    await cuts.reduce<Promise<unknown>>((before, cut) => before.then(async () => {
      writeFileSync(path, Buffer.concat([priorBytes, finalBytes.subarray(0, cut)]));
      expect(await readBack(path)).toEqual(ok(rows.slice(0, -1)));
      expect(statSync(path).size).toBe(priorBytes.length);
      await written(path, [last]);
      expect(await readBack(path)).toEqual(ok(rows));
    }), Promise.resolve());
  });

  test("a damaged file is a fault, left as it is, and nothing is read from it", async () => {
    const path = scratch();
    await written(path, rows);
    const damaged = readFileSync(path).map((byte, i) => (i === 30 ? byte ^ 1 : byte));
    writeFileSync(path, damaged);
    expect(await readBack(path)).toMatchObject({ ok: false, error: { _tag: "corrupt", offset: 0 } });
    expect(readFileSync(path).equals(damaged)).toBe(true);
  });

  test("R-DURABLE a length garbled in a MIDDLE record is a fault, and no durable row is cut away", async () => {
    const path = scratch();
    const three = rows.slice(-3);
    await written(path, three);
    const sizes = three.map((row) => {
      const made = recordOf(row);
      return made.ok ? made.value.length : expect.unreachable("record");
    });
    const start = sizes[0] ?? 0;
    const huge = [0x7f, 0xff, 0xff, 0xff];
    const garbled = Uint8Array.from(readFileSync(path), (byte, i) => huge[i - start] ?? byte);
    writeFileSync(path, garbled);
    expect(await readBack(path)).toMatchObject({ ok: false, error: { _tag: "corrupt", offset: sizes[0] } });
    expect(readFileSync(path).equals(Buffer.from(garbled))).toBe(true);
  });

  test("R-DURABLE a write that faults half way stops the Disk: later rows refused, the tear cut at start", async () => {
    const path = scratch();
    const real = await opened(path);
    const half: Disk = {
      ...real,
      run: async (ops) => {
        const write = ops[0];
        if (write?._tag !== "write") return real.run(ops);
        await real.run([{ _tag: "write", bytes: write.bytes.subarray(0, write.bytes.length >> 1) }]);
        return err({ _tag: "disk", op: "write", reason: "ENOSPC" });
      },
    };
    const stopped = failStop(half);
    const [one, two, three] = rows as readonly [Row, Row, Row];
    expect(await keep(stopped, one)).toEqual(err({ _tag: "disk", op: "write", reason: "ENOSPC" }));
    expect(await keep(stopped, two)).toMatchObject({ ok: false, error: { _tag: "disk", op: "write" } });
    const refused = { ok: false, error: { reason: "stopped after an earlier fault" } };
    expect(await keep(stopped, three)).toMatchObject(refused);
    expect(await stopped.read()).toMatchObject({ ok: true });
    await real.close();
    expect(await readBack(path)).toEqual(ok([]));
    expect(statSync(path).size).toBe(0);
  });

  test("R-DURABLE a sync that faults stops the Disk too: not retried, nothing appended after it", async () => {
    const path = scratch();
    const real = await opened(path);
    const syncFault: Disk = {
      ...real,
      run: async (ops) => {
        await real.run(ops.filter((op) => op._tag !== "sync"));
        return err({ _tag: "disk", op: "sync", reason: "EIO" });
      },
    };
    const stopped = failStop(syncFault);
    const [one, two] = rows as readonly [Row, Row];
    expect(await keep(stopped, one)).toMatchObject({ ok: false, error: { op: "sync" } });
    expect(await keep(stopped, two)).toMatchObject({ ok: false, error: { reason: "stopped after an earlier fault" } });
    await real.close();
  });

  test("R-DURABLE the file disk stops at its first fault: a write on a closed file, then runs refused", async () => {
    const disk = await opened(scratch());
    await disk.close();
    const [one, two] = rows as readonly [Row, Row];
    expect(await keep(disk, one)).toMatchObject({ ok: false, error: { _tag: "disk", op: "write" } });
    expect(await keep(disk, two)).toMatchObject({ ok: false, error: { reason: "stopped after an earlier fault" } });
  });

  test("a file that cannot be opened is a fault with the step that failed", async () => {
    const disk = await fileDisk(`${tmpdir()}/no-such-folder-for-wal/wal.log`);
    expect(disk).toMatchObject({ ok: false, error: { _tag: "disk", op: "open" } });
  });
});

describe("host/shell/store a Runtime comes back from the file", () => {
  test("R-DURABLE the rows of two Runtimes, kept and read from files, replay and ask the chain as before", async () => {
    const cases = [{ run: aliceRun, id: ALICE }, { run: bobRun, id: BOB }];
    await Promise.all(cases.map(async ({ run, id }) => {
      const path = scratch();
      const wal = walOf(run, id);
      await written(path, wal);
      const back = await readBack(path);
      const kept = back.ok ? back.value : expect.unreachable("openWal");
      const setup = run.hosts.get(id)?.setup ?? expect.unreachable("setup");
      const live = unhalted(reopen(setup, [emptyEntity(id)], wal, BOUNDS));
      const again = unhalted(reopen(setup, [emptyEntity(id)], kept, BOUNDS));
      expect(again.effects).toEqual(live.effects);
      expect(again.host.runtime.entities).toEqual(live.host.runtime.entities);
    }));
  });
});
