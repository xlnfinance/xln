// loader-bytes.test.ts — `Loader.read` returning BYTES is a first-class source, not a
// second-class one that happens to work for ASCII.
//
// `FsReadLike` is satisfied as-is by node's `fs.promises` and plexus-vfs's `.promises`, both of
// which return a `Uint8Array` when called with no encoding argument — the documented shape
// `makeFsLoader(fs.promises)` produces. Every builtin resolver used to coerce that with
// `String(contents)`, which joins byte VALUES with commas instead of decoding UTF-8: a
// `.scm` module whose first two bytes are `;;` arrived at the parser as the text `"59,59,…"`,
// read as a number followed by a free `,`, and surfaced as `Unbound variable \`unquote'` at
// line 1 — an error naming a construct the file never contained. These rows pin the decode
// (`contentsToText`) at each builtin kind so no format can regress into that garble.

import { describe, expect, it } from "vitest";

import { exec } from "@inhuman.tools/arrival";

import { arrivalLoaderCapability } from "../loader-capability.js";
import { makeFsLoader } from "../loader.js";

/** A loader over a byte-returning fs — `fs.promises.readFile(path)` with no encoding. */
const byteFiles = (table: Record<string, string>) =>
  makeFsLoader({
    readFile: (path) => {
      const hit = table[path];
      if (hit === undefined) throw new Error(`no such file: ${path}`);
      return new TextEncoder().encode(hit);
    },
  });

describe("Loader.read returning Uint8Array", () => {
  it("a .scm module decodes as UTF-8 — comment bytes are not read as numbers", async () => {
    const results = await exec(`(require "lib.scm") (+ lib-answer 1)`, {
      capabilities: [arrivalLoaderCapability],
      config: { loader: byteFiles({ "lib.scm": `;; the answer, minus one\n(define lib-answer 41)` }) },
    });
    expect(Number(results.at(-1))).toBe(42);
  });

  it("multi-byte UTF-8 survives the round trip (not one byte per character)", async () => {
    const results = await exec(`(require "lib.scm") greeting`, {
      capabilities: [arrivalLoaderCapability],
      config: { loader: byteFiles({ "lib.scm": `(define greeting "héllo — 🌍")` }) },
    });
    expect(results.at(-1)).toBe("héllo — 🌍");
  });

  it("a .json data module parses from bytes", async () => {
    const results = await exec(`(define cfg (require "cfg.json")) cfg`, {
      capabilities: [arrivalLoaderCapability],
      config: { loader: byteFiles({ "cfg.json": `{"name":"wörld"}` }) },
    });
    expect(results.at(-1)).toMatchObject({ name: "wörld" });
  });

  it("a .txt module yields its text, not its byte list", async () => {
    const results = await exec(`(require "note.txt")`, {
      capabilities: [arrivalLoaderCapability],
      config: { loader: byteFiles({ "note.txt": "plain words" }) },
    });
    expect(results.at(-1)).toBe("plain words");
  });
});
