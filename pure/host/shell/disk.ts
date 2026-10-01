// What the shell asks of a disk, as data (R-DURABLE). A row is made durable by a short list of operations that run in
// order, and the shell reports the row durable only once the whole list has completed, the last of which is a sync. The
// operations are values, so the order a crash can cut and the bytes a tear can leave are tested without a disk.
import type { Result } from "../../kernel/core/result.ts";
import { err, ok } from "../../kernel/core/result.ts";
import type { Tagged } from "../../kernel/core/tagged.ts";

export type DiskOp =
  | Tagged<"write", { bytes: Uint8Array }>
  | Tagged<"truncate", { length: number }>
  | Tagged<"sync">;

export type DiskFault = Tagged<"disk", { op: DiskOp["_tag"] | "open" | "read" | "close"; reason: string }>;

/**
 * A file the shell appends rows to. `run` completes when every operation has completed, in order, and stops at the
 * first fault; a `sync` completes only when the bytes written before it are on the medium. The shell never has two
 * `run` calls in flight: a frame is staged, made durable, and only then is the next begun.
 */
export type Disk = Readonly<{
  read: () => Promise<Result<Uint8Array, DiskFault>>;
  run: (ops: readonly DiskOp[]) => Promise<Result<void, DiskFault>>;
  close: () => Promise<Result<void, DiskFault>>;
}>;

/** One operation, told which operations came before it and completed. */
export type Exec = (op: DiskOp, done: readonly DiskOp[]) => Promise<Result<void, DiskFault>>;

/** The operations in order, each started when the one before has completed, and none after a fault. */
export const sequence = (ops: readonly DiskOp[], exec: Exec): Promise<Result<void, DiskFault>> =>
  ops.reduce<Promise<Result<readonly DiskOp[], DiskFault>>>(
    (before, op) => before.then((done) =>
      (done.ok ? exec(op, done.value).then((ran): Result<readonly DiskOp[], DiskFault> =>
        (ran.ok ? ok([...done.value, op]) : ran)) : done)),
    Promise.resolve(ok([])),
  ).then((all) => (all.ok ? ok(undefined) : all));

/**
 * After a run faults, every later run is refused. A write that faulted may have left half a record, and a sync that
 * faulted is not safe to retry (what it covered may or may not be on the medium); a record appended after either would
 * turn a tear, which the next start cuts, into damage in the middle of the file, which it refuses. So the Disk stops
 * at the first fault, and the shell with it: the next start reads the file, cuts the tear, and goes on from the rows
 * that are there. The latch is the platform's one-way signal; `read` and `close` are not refused.
 */
export const failStop = (disk: Disk): Disk => {
  const stopped = new AbortController();
  return {
    ...disk,
    run: (ops) => {
      if (stopped.signal.aborted) {
        const op = ops[0]?._tag ?? "write";
        return Promise.resolve(err({ _tag: "disk", op, reason: "stopped after an earlier fault" }));
      }
      return disk.run(ops).then((done) => {
        if (!done.ok) stopped.abort();
        return done;
      });
    },
  };
};
