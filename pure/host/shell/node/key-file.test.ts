// The key file: a private file holding a valid secret gives a Key; a file others can read, a missing file, text that is
// not a key and a secret off the curve each give a fault that names which (R-LINK-AUTH).
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { unwrapOr } from "../../../kernel/core/result.ts";
import { keyOf } from "../link/link.ts";
import { loadKey } from "./key-file.ts";

const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const HEX = Array.from(SECRET, (byte) => byte.toString(16).padStart(2, "0")).join("");

const fileWith = (text: string, mode: number): string => {
  const dir = mkdtempSync(`${tmpdir()}/key-`);
  const path = `${dir}/runtime.key`;
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
};

describe("host/shell/key-file the signing key comes from a file only its owner can read", () => {
  test("R-LINK-AUTH a private file with the secret as hex gives the key, whatever the prefix or newline", async () => {
    const want = unwrapOr(keyOf(SECRET), () => expect.unreachable("key"));
    expect(await loadKey(fileWith(HEX, 0o600))).toEqual({ ok: true, value: want });
    expect(await loadKey(fileWith(`0x${HEX}\n`, 0o400))).toEqual({ ok: true, value: want });
  });

  test("R-LINK-AUTH a file the group or others can read is refused, and its mode is named", async () => {
    const refused = { ok: false, error: { _tag: "key_file_not_private" } };
    expect(await loadKey(fileWith(HEX, 0o640))).toMatchObject({ ...refused, error: { ...refused.error, mode: 0o640 } });
    expect(await loadKey(fileWith(HEX, 0o604))).toMatchObject(refused);
  });

  test("a missing file, text that is not hex, a short secret and the zero secret are faults, not keys", async () => {
    const notAKey = { ok: false, error: { _tag: "key_file_not_a_key" } };
    expect(await loadKey(`${tmpdir()}/no-such-dir/none.key`))
      .toMatchObject({ ok: false, error: { _tag: "key_file_unreadable" } });
    expect(await loadKey(fileWith("not a key", 0o600))).toMatchObject(notAKey);
    expect(await loadKey(fileWith(HEX.slice(2), 0o600))).toMatchObject(notAKey);
    expect(await loadKey(fileWith("00".repeat(32), 0o600))).toMatchObject(notAKey);
  });
});
