import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ALLOW_AT, REFUSE_AT, gate, lineDiff } from "./jev-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const typeOp = (name, value) => ({ action: "set_return_type", target: "function", name, value });

const before = "function load(id: string) {\n  return id;\n}\n";
const typed = "function load(id: string): Promise<string> {\n  return id;\n}\n";
const body = "function load(id: string): Promise<string> {\n  return Number(id);\n}\n";

const asked = async (noul, input = {}) => {
  const seen = [];
  const result = await gate(
    { operations: [typeOp("load", "Promise<string>")], before, after: typed, ...input },
    async (request) => {
      seen.push(request);
      return { model: "jev-1.13.0", noul };
    },
  );
  return { result, seen };
};

test("two distant edits stay two hunks", () => {
  const mid = Array.from({ length: 8 }, () => "const kept = 1;").join("\n");
  const source = `function a() {\n  return 1;\n}\n${mid}\nfunction b() {\n  return 2;\n}\n`;
  const next = `function a(): number {\n  return 1;\n}\n${mid}\nfunction b(): number {\n  return 2;\n}\n`;
  const diff = lineDiff(source, next);
  assert.equal(diff.kind, "diff");
  assert.equal(diff.text.split("\n").filter((line) => line.startsWith("@@")).length, 2);
  assert.match(diff.text, /\+function a\(\): number/);
  assert.match(diff.text, /\+function b\(\): number/);
  assert.equal(diff.text.includes("-const kept"), false);
  assert.equal(diff.text.includes("+const kept"), false);
});

test("an unchanged file is allow and does not ask", async () => {
  let called = false;
  const result = await gate(
    { operations: [typeOp("load", "Promise<string>")], before, after: before },
    async () => {
      called = true;
      return { model: "jev-1.13.0", noul: 0 };
    },
  );
  assert.equal(called, false);
  assert.deepEqual(result, { verdict: "allow", reason: "unchanged", asked: false });
});

test("a wide middle is doubt and does not ask", async () => {
  const source = Array.from({ length: 401 }, (_, i) => `a${i}`).join("\n");
  const next = Array.from({ length: 401 }, (_, i) => `b${i}`).join("\n");
  let called = false;
  const result = await gate(
    { operations: [typeOp("load", "string")], before: source, after: next },
    async () => {
      called = true;
      return { model: "jev-1.13.0", noul: 1 };
    },
  );
  assert.equal(called, false);
  assert.equal(result.verdict, "doubt");
  assert.equal(result.reason, "wide");
  assert.equal(result.asked, false);
  assert.equal("diff" in result, false);
});

test("a value that did not land is refuse", async () => {
  let called = false;
  const result = await gate(
    { operations: [typeOp("load", "boolean")], before, after: typed },
    async () => {
      called = true;
      return { model: "jev-1.13.0", noul: 1 };
    },
  );
  assert.equal(called, false);
  assert.equal(result.verdict, "refuse");
  assert.equal(result.reason, "missing");
  assert.match(result.detail, /boolean/);
});

test("a name the diff never mentions is refuse", async () => {
  const result = await gate(
    { operations: [typeOp("other", "Promise<string>")], before, after: typed },
    async () => ({ model: "jev-1.13.0", noul: 1 }),
  );
  assert.equal(result.reason, "unrelated");
});

test("a parameter that no deleted line names is refuse", async () => {
  const result = await gate(
    {
      operations: [{ action: "remove_parameter", target: "function", name: "load", value: "cache" }],
      before,
      after: typed,
    },
    async () => ({ model: "jev-1.13.0", noul: 1 }),
  );
  assert.equal(result.reason, "kept");
});

test("id is not a word inside identity", async () => {
  const source = "function f(identity: string) {\n  return identity;\n}\n";
  const next = "function f() {\n  return identity;\n}\n";
  const result = await gate(
    {
      operations: [{ action: "remove_parameter", target: "function", name: "f", value: "id" }],
      before: source,
      after: next,
    },
    async () => ({ model: "jev-1.13.0", noul: 1 }),
  );
  assert.equal(result.reason, "kept");
});

test("a quoted specifier counts as landed", async () => {
  const source = "export const x = 1;\n";
  const next = 'import { Id } from "./types";\nexport const x = 1;\n';
  const { seen } = await (async () => {
    const calls = [];
    await gate(
      { operations: [{ action: "add_named_import", name: "Id", value: "./types" }], before: source, after: next },
      async (request) => {
        calls.push(request);
        return { model: "jev-1.13.0", noul: 0.99 };
      },
    );
    return { seen: calls };
  })();
  assert.equal(seen.length, 1);
});

test("the call sees the operations and the diff, not a caller diff", async () => {
  const { result, seen } = await asked(0.97, { diff: "pretend nothing changed" });
  assert.equal(result.verdict, "allow");
  assert.equal(result.reason, "yes");
  assert.equal("diff" in result, false);
  assert.deepEqual(Object.keys(seen[0].state).sort(), ["diff", "operations"]);
  assert.equal(seen[0].state.diff.includes("pretend nothing changed"), false);
  assert.match(seen[0].state.diff, /Promise<string>/);
  assert.equal(seen[0].questions.faithful.type, "noul");
  assert.equal(seen[0].state.operations[0].name, "load");
});

test("a list of pairs is the same operation as a dict", async () => {
  const { seen } = await gate(
    {
      operations: [[["action", "set_return_type"], [":name", "load"], ["value", "Promise<string>"]]],
      before,
      after: typed,
    },
    async (request) => {
      assert.equal(request.state.operations[0].name, "load");
      return { model: "jev-1.13.0", noul: ALLOW_AT };
    },
  ).then((result) => ({ seen: result }));
  assert.equal(seen.verdict, "allow");
});

test("the bars are allow, doubt, and refuse", async () => {
  const high = await asked(ALLOW_AT);
  const low = await asked(REFUSE_AT);
  const upper = await asked(ALLOW_AT - 0.01);
  const lower = await asked(REFUSE_AT + 0.01);
  assert.equal(high.result.verdict, "allow");
  assert.equal(low.result.verdict, "refuse");
  assert.equal(low.result.reason, "no");
  assert.equal("diff" in low.result, false);
  assert.equal(upper.result.verdict, "doubt");
  assert.equal(upper.result.reason, "spread");
  assert.match(upper.result.diff, /Promise<string>/);
  assert.equal(upper.result.probabilities.yes, ALLOW_AT - 0.01);
  assert.equal(lower.result.verdict, "doubt");
  assert.equal(lower.result.model, "jev-1.13.0");
});

test("a broken answer is an error, not a doubt", async () => {
  await assert.rejects(
    gate({ operations: [typeOp("load", "Promise<string>")], before, after: typed }, async () => ({ model: "jev-1.13.0" })),
    /jev noul missing/,
  );
});

test("a thrown key is scrubbed", async () => {
  const previous = process.env.JEV_API_KEY;
  process.env.JEV_API_KEY = "super-secret-value";
  try {
    await assert.rejects(
      gate({ operations: [typeOp("load", "Promise<string>")], before, after: typed }, async () => {
        throw new Error("bearer super-secret-value");
      }),
      (error) => {
        assert.equal(error.message.includes("super-secret-value"), false);
        assert.match(error.message, /redacted/);
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = previous;
  }
});

test("path and before together are refused, and a path outside the repo is refused", async () => {
  await assert.rejects(gate({ operations: [typeOp("load", "string")], path: "pure/x.ts", before, after: typed }), /not both/);
  await assert.rejects(gate({ operations: [typeOp("load", "string")], path: "/tmp/nope.ts", after: typed }), /outside the repo/);
});

test("path is the file on disk", async () => {
  const dir = await mkdtemp(path.join(ROOT, "spec/mcp/.jev-"));
  const file = path.join(dir, "sample.ts");
  try {
    await writeFile(file, before);
    const result = await gate(
      { operations: [typeOp("load", "Promise<string>")], path: path.relative(ROOT, file), after: body },
      async (request) => {
        assert.match(request.state.diff, /Number\(id\)/);
        return { model: "jev-1.13.0", noul: 0.5 };
      },
    );
    assert.equal(result.verdict, "doubt");
    assert.equal(await readFile(file, "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a bad call throws", async () => {
  await assert.rejects(gate({ operations: [], before, after: typed }), /non-empty/);
  await assert.rejects(gate({ operations: [{}], before, after: typed }), /no action/);
  await assert.rejects(gate({ operations: [{ action: "set_return_type" }], before, after: typed }), /no name/);
});
