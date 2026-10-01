// Moving rules between the one-file layout (register.json, { policy, rows }) and the folder (register/<id>.json). Pure: texts in, texts out;
// rules/layout/register-split.ts reads and writes the files. The move is mechanical: a row's data is untouched, only its file changes.
import { isDeepStrictEqual } from "node:util";
import { parseJson, ruleFileName, type ParseError, type RegisterFile, type Result } from "../register.ts";

export type RawRow = Readonly<Record<string, unknown>>;

const failure = (detail: string): Result<never, ParseError> => ({ ok: false, error: { _tag: "BadRegister", where: "split", detail } });

const isRawRow = (value: unknown): value is RawRow => typeof value === "object" && value !== null && !Array.isArray(value);

// Rows of an old-layout file, as the JSON holds them. Every row needs a string id: it names the file.
export const oldRows = (text: string): Result<readonly RawRow[], ParseError> => {
  const json = parseJson(text);
  if (!json.ok) return json;
  const rows = isRawRow(json.value) ? json.value["rows"] : undefined;
  if (!Array.isArray(rows)) return failure('the file must be { "rows": [...] }');
  const bad = rows.findIndex((row) => !isRawRow(row) || typeof row["id"] !== "string" || row["id"] === "");
  return bad !== -1 ? failure(`rows[${bad}] has no id`) : { ok: true, value: rows as readonly RawRow[] };
};

// One rule's file: the row printed as the old file printed it (one space of indent), plus a final newline.
export const fileOf = (row: RawRow): RegisterFile => ({ name: ruleFileName(String(row["id"])), text: `${JSON.stringify(row, null, 1)}\n` });

const duplicate = (rows: readonly RawRow[]): string | undefined =>
  rows.map((row) => String(row["id"])).find((id, at, ids) => ids.indexOf(id) !== at);

export const splitFiles = (text: string): Result<readonly RegisterFile[], ParseError> => {
  const rows = oldRows(text);
  if (!rows.ok) return rows;
  const twice = duplicate(rows.value);
  return twice !== undefined ? failure(`rule ${twice} appears twice in the old file`) : { ok: true, value: rows.value.map(fileOf) };
};

const dataOf = (text: string): unknown => {
  const parsed = parseJson(text);
  return parsed.ok ? parsed.value : undefined;
};

// The folder holds exactly the rules of the old file, and each file's data is that row's data, key for key and in the same order.
// Returns what differs; an empty list is the equality the move must show.
export const differences = (oldText: string, files: readonly RegisterFile[]): readonly string[] => {
  const rows = oldRows(oldText);
  if (!rows.ok) return [rows.error.detail];
  const wanted = rows.value.map(fileOf);
  const missing = wanted.filter((each) => !files.some((file) => file.name === each.name)).map((each) => `${each.name} is missing`);
  const extra = files.filter((file) => !wanted.some((each) => each.name === file.name)).map((file) => `${file.name} is not in the old file`);
  const changed = wanted.flatMap((each) => {
    const file = files.find((candidate) => candidate.name === each.name);
    return file === undefined || JSON.stringify(dataOf(file.text)) === JSON.stringify(dataOf(each.text)) ? [] : [`${each.name} differs from its row`];
  });
  return [...missing, ...extra, ...changed];
};

export type Port = Readonly<{ writes: readonly RegisterFile[]; deletes: readonly string[]; conflicts: readonly string[] }>;

const rowById = (rows: readonly RawRow[], id: string): RawRow | undefined => rows.find((row) => row["id"] === id);

const sameRow = (left: RawRow | undefined, right: RawRow | undefined): boolean => isDeepStrictEqual(left, right);

// What a branch that edited the old file changed, as edits to the folder: rows it added or changed are written, rows it removed are deleted.
// `current` is the folder as it is now. A row the folder has since changed, in a way other than the branch's, is a conflict and is left alone.
export const port = (base: readonly RawRow[], theirs: readonly RawRow[], current: readonly RegisterFile[]): Port => {
  const ids = [...new Set([...base, ...theirs].map((row) => String(row["id"])))];
  const edits = ids.flatMap((id) => {
    const before = rowById(base, id);
    const after = rowById(theirs, id);
    if (sameRow(before, after)) return [];
    const file = current.find((candidate) => candidate.name === ruleFileName(id));
    const now = file === undefined ? undefined : dataOf(file.text);
    const folderMoved = !(file === undefined ? before === undefined : before !== undefined && isDeepStrictEqual(now, before));
    const already = after === undefined ? file === undefined : file !== undefined && isDeepStrictEqual(now, after);
    return already ? [] : [{ id, after, folderMoved }];
  });
  const conflicts = edits.filter((edit) => edit.folderMoved).map((edit) => `${ruleFileName(edit.id)}: the folder changed this rule since the branch started`);
  const clean = edits.filter((edit) => !edit.folderMoved);
  return {
    writes: clean.flatMap((edit) => (edit.after === undefined ? [] : [fileOf(edit.after)])),
    deletes: clean.filter((edit) => edit.after === undefined).map((edit) => ruleFileName(edit.id)),
    conflicts,
  };
};
