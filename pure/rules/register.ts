// register.json to a typed Register. The file is data the coordinator edits, so it is parsed, not trusted.
import { LAYERS, byLayer, type Cell, type Killer, type KillerKind, type Layer, type Register, type Row } from "./model.ts";

export type Result<T, E> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: E }>;

export type ParseError = Readonly<{ _tag: "BadRegister"; where: string; detail: string }>;

const fail = (where: string, detail: string): Result<never, ParseError> => ({
  ok: false,
  error: { _tag: "BadRegister", where, detail },
});

const pass = <T>(value: T): Result<T, never> => ({ ok: true, value });

// "-" is absent, "hold" is hold, "owed: <who brings it>" is owed.
export const parseCell = (where: string, text: unknown): Result<Cell, ParseError> => {
  if (text === "-") return pass({ _tag: "absent" });
  if (text === "hold") return pass({ _tag: "hold" });
  const owed = typeof text === "string" ? /^owed:\s*(\S.*)$/.exec(text) : null;
  return owed?.[1] === undefined ? fail(where, `cell must be "-", "hold" or "owed: <by>", got ${JSON.stringify(text)}`) : pass({ _tag: "owed", by: owed[1] });
};

const isLayer = (text: string): text is Layer => (LAYERS as readonly string[]).includes(text);

const isKillerKind = (text: unknown): text is KillerKind => text === "test" || text === "bug" || text === "mutant";

type Raw = Readonly<Record<string, unknown>>;

const isRaw = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

const parseKiller = (where: string, raw: unknown): Result<Killer, ParseError> => {
  if (!isRaw(raw)) return fail(where, "killer must be an object");
  const { kind, layer, name, owed } = raw;
  if (!isKillerKind(kind)) return fail(where, `killer kind must be test, bug or mutant, got ${JSON.stringify(kind)}`);
  if (typeof layer !== "string" || !isLayer(layer)) return fail(where, `killer layer is not a layer: ${JSON.stringify(layer)}`);
  if (typeof name !== "string" || name === "") return fail(where, "killer needs a name");
  if (owed !== undefined && (typeof owed !== "string" || owed === "")) return fail(where, "killer owed must say who brings it");
  return pass(owed === undefined ? { kind, layer, name } : { kind, layer, name, owed });
};

const collect = <T>(items: readonly Result<T, ParseError>[]): Result<readonly T[], ParseError> => {
  const failed = items.find((item) => !item.ok);
  return failed !== undefined && !failed.ok ? failed : pass(items.flatMap((item) => (item.ok ? [item.value] : [])));
};

const parseCells = (where: string, raw: unknown): Result<Row["cells"], ParseError> => {
  if (!isRaw(raw)) return fail(where, "layers must be an object");
  const unknownLayer = Object.keys(raw).find((key) => !isLayer(key));
  if (unknownLayer !== undefined) return fail(where, `unknown layer ${unknownLayer}`);
  const parsed = byLayer((layer) => parseCell(`${where}.${layer}`, raw[layer] ?? "-"));
  const failed = LAYERS.map((layer) => parsed[layer]).find((each) => !each.ok);
  if (failed !== undefined && !failed.ok) return failed;
  return pass(byLayer((layer) => {
    const each = parsed[layer];
    return each.ok ? each.value : { _tag: "absent" };
  }));
};

const parseRow = (raw: unknown, index: number): Result<Row, ParseError> => {
  const where = `rows[${index}]`;
  if (!isRaw(raw)) return fail(where, "row must be an object");
  const { id, statement, source, layers, killers, retired_by: retiredBy } = raw;
  if (typeof id !== "string" || id === "") return fail(where, "row needs an id");
  if (typeof statement !== "string" || statement === "") return fail(id, "row needs a statement");
  if (typeof source !== "string" || source === "") return fail(id, "row needs a source decision");
  if (!Array.isArray(killers)) return fail(id, "killers must be a list (it may be empty; the gate then fails the row)");
  const cells = parseCells(id, layers);
  const parsedKillers = collect(killers.map((killer, at) => parseKiller(`${id}.killers[${at}]`, killer)));
  if (!cells.ok) return cells;
  if (!parsedKillers.ok) return parsedKillers;
  if (retiredBy === undefined) return pass({ id, statement, source, cells: cells.value, killers: parsedKillers.value });
  if (!Array.isArray(retiredBy) || retiredBy.length === 0 || !retiredBy.every((each) => typeof each === "string")) {
    return fail(id, "retired_by must list the successor ids");
  }
  return pass({ id, statement, source, cells: cells.value, killers: parsedKillers.value, retiredBy });
};

// The boundary where a JSON parse may throw (registered in style/README): bad text is a BadRegister, not a crash. rules/progress.ts reads the
// deploy manifest through it too.
export const parseJson = (text: string): Result<unknown, ParseError> => {
  try {
    return pass(JSON.parse(text));
  } catch (cause) {
    return fail("register", `not JSON: ${String(cause)}`);
  }
};

export const parseRegister = (text: string): Result<Register, ParseError> => {
  const json = parseJson(text);
  if (!json.ok) return json;
  const parsed = json.value;
  if (!isRaw(parsed) || !Array.isArray(parsed["rows"])) return fail("register", 'the file must be { "rows": [...] }');
  return collect(parsed["rows"].map(parseRow));
};
