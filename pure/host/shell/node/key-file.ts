// The one key the Host's shell signs with, read from a file only its owner can touch (R-LINK-AUTH, F1). The file holds
// 32 bytes as hex, with or without a 0x prefix and a trailing newline. A key the group or others can read is refused:
// a key that others could have read is not a key this Host can say is only its own. One key serves the link handshake
// and the batch Hanko; the two never sign the same bytes, because the handshake digest begins with its own domain
// string and a batch digest is a keccak256 hash.
import { readFile, stat } from "node:fs/promises";
import { err, flatMap, mapErr, type Result } from "../../../kernel/core/result.ts";
import type { Tagged } from "../../../kernel/core/tagged.ts";
import { hexToBytes } from "../../../kernel/encoding/bytes.ts";
import { keyOf, type Key } from "../link/link.ts";
import { attempt } from "./attempt.ts";

export type KeyFileFault =
  | Tagged<"key_file_unreadable", { path: string; reason: string }>
  | Tagged<"key_file_not_private", { path: string; mode: number }>
  | Tagged<"key_file_not_a_key", { path: string }>;

/** The permission bits of the group and others: none may be set. */
const OTHERS = 0o077;

const unreadable = (path: string) => (reason: string): KeyFileFault => ({ _tag: "key_file_unreadable", path, reason });

const read = (path: string): Promise<Result<string, KeyFileFault>> => attempt(readFile(path, "utf8"), unreadable(path));

const modeOf = (path: string): Promise<Result<number, KeyFileFault>> =>
  attempt(stat(path).then((info) => info.mode), unreadable(path));

const keyIn = (path: string, text: string): Result<Key, KeyFileFault> => {
  const raw = hexToBytes(text.trim().startsWith("0x") ? text.trim() : `0x${text.trim()}`);
  const notAKey: KeyFileFault = { _tag: "key_file_not_a_key", path };
  return raw.ok ? mapErr(keyOf(raw.value), () => notAKey) : err(notAKey);
};

/** The key in the file at `path`, if the file is the owner's alone and holds a valid secp256k1 secret. */
export const loadKey = async (path: string): Promise<Result<Key, KeyFileFault>> => {
  const mode = await modeOf(path);
  if (!mode.ok) return mode;
  if ((mode.value & OTHERS) !== 0) return err({ _tag: "key_file_not_private", path, mode: mode.value & 0o777 });
  return flatMap(await read(path), (text) => keyIn(path, text));
};
