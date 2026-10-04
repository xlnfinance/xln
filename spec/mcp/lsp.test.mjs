import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { definition, references } from "./lsp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const slow = { timeout: 180000 };

const identifier = (file, needle) => {
  const lines = readFileSync(path.join(ROOT, file), "utf8").split("\n");
  const index = lines.findIndex((text) => text.includes(needle));
  if (index < 0) throw new Error(`${needle} is not in ${file}`);
  return { path: file, line: index + 1, column: lines[index].indexOf(needle) + 1 };
};

const key = (at) => `${at.path}:${at.line}:${at.column}`;

test("a path outside the repo is refused", async () => {
  await assert.rejects(() => references({ path: "/tmp/nope.ts", line: 1, column: 1 }), /outside the repo/);
});

test("line 0 is refused", async () => {
  await assert.rejects(
    () => references({ path: "pure/entity/fixtures.ts", line: 0, column: 1 }),
    /line is a number from 1/,
  );
});

test("a Scheme file is refused", async () => {
  await assert.rejects(() => references({ path: "spec/account/frames.scm", line: 1, column: 1 }), /only a \.ts or \.tsx file/);
});

test("a comment is not a symbol", slow, async () => {
  const spot = identifier("pure/entity/fixtures.ts", "told `inputs`");
  const column = spot.column + "told `".length;
  await assert.rejects(() => references({ path: spot.path, line: spot.line, column }), /no symbol/);
});

test("the two open bindings stay apart", slow, async () => {
  const before = statSync(path.join(ROOT, "pure/entity/fixtures.ts")).mtimeMs;
  const fixture = identifier("pure/entity/fixtures.ts", "export const open");
  const link = identifier("pure/host/shell/link/link.ts", "export const open");
  const fixtureAt = { ...fixture, column: fixture.column + "export const ".length };
  const linkAt = { ...link, column: link.column + "export const ".length };
  const uses = await references(fixtureAt);
  const records = await references(linkAt);
  assert.equal(uses.name, "open");
  assert.equal(records.name, "open");
  assert.ok(uses.locations.some((at) => at.path === "pure/entity/frame.test.ts"));
  assert.ok(records.locations.some((at) => at.path === "pure/host/shell/link/link.test.ts"));
  assert.equal(uses.locations.some((at) => at.path === linkAt.path), false);
  assert.equal(records.locations.some((at) => at.path === fixtureAt.path), false);
  const seen = new Set(uses.locations.map(key));
  assert.equal(records.locations.some((at) => seen.has(key(at))), false);
  assert.equal(statSync(path.join(ROOT, "pure/entity/fixtures.ts")).mtimeMs, before);
});

test("a use of the fixture open defines the fixture", slow, async () => {
  const use = identifier("pure/entity/frame.test.ts", "peers.map(open)");
  const column = use.column + "peers.map(".length;
  const found = await definition({ path: use.path, line: use.line, column });
  const fixture = identifier("pure/entity/fixtures.ts", "export const open");
  assert.deepEqual(found.locations, [{
    path: fixture.path,
    line: fixture.line,
    column: fixture.column + "export const ".length,
    definition: true,
  }]);
});
