// The Disk of a real file: the one place the shell touches fs. The file is opened for append, so a write always lands
// at the end; a sync is fsync of the file; and the directory is synced when the file is opened, so a file that was just
// created is not lost to a crash that takes its directory entry (R-DURABLE).
import { open, readFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { err, ok, type Result } from "../../../kernel/core/result.ts";
import type { Disk, DiskFault, DiskOp, Exec } from "../disk/disk.ts";
import { failStop, sequence } from "../disk/disk.ts";

type Step = DiskFault["op"];

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const attempt = <T>(op: Step, work: Promise<T>): Promise<Result<T, DiskFault>> =>
  work.then((value) => ok(value), (cause): Result<T, DiskFault> => err({ _tag: "disk", op, reason: reasonOf(cause) }));

const nothing = (r: Promise<Result<unknown, DiskFault>>): Promise<Result<void, DiskFault>> =>
  r.then((done) => (done.ok ? ok(undefined) : done));

const syncDirectory = async (path: string): Promise<Result<void, DiskFault>> => {
  const dir = await attempt("open", open(dirname(path), "r"));
  if (!dir.ok) return dir;
  const synced = await nothing(attempt("sync", dir.value.sync()));
  const closed = await nothing(attempt("close", dir.value.close()));
  return synced.ok ? closed : synced;
};

const execOn = (file: FileHandle): Exec => (op: DiskOp) => {
  switch (op._tag) {
    case "write": return nothing(attempt("write", file.appendFile(op.bytes)));
    case "truncate": return nothing(attempt("truncate", file.truncate(op.length)));
    case "sync": return nothing(attempt("sync", file.sync()));
  }
};

const diskOf = (path: string, file: FileHandle): Disk => ({
  read: () => attempt("read", readFile(path)),
  run: (ops) => sequence(ops, execOn(file)),
  close: () => nothing(attempt("close", file.close())),
});

/** The file at `path`, created if it is not there, with its directory synced. */
export const fileDisk = async (path: string): Promise<Result<Disk, DiskFault>> => {
  const file = await attempt("open", open(path, "a+"));
  if (!file.ok) return file;
  const synced = await syncDirectory(path);
  if (synced.ok) return ok(failStop(diskOf(path, file.value)));
  await attempt("close", file.value.close());
  return synced;
};
