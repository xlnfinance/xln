// The rule register's vocabulary: layers, cells, killers, rows, and what the gate can say about them.
// Everything here is data and total functions. Reading files and exiting happen in check.ts.

export type Layer = "arrival" | "quint" | "contract" | "rig" | "ts";

export const LAYERS: readonly Layer[] = ["arrival", "quint", "contract", "rig", "ts"];

// A cell says what one layer owes one rule. A live rule states every layer; the gate fails on `unstated`.
//   unstated  nobody has said what this layer owes the rule ("-" in the file, or no entry); red on a live row
//   na        the layer has no part in this rule, and the cell says why in one line; a name that carries the id here is red
//   hold      a name in this layer must carry the id; the gate fails when none does
//   owed      the layer must hold it, but a named PR or slice brings the name; shown as open, never hidden
export type Cell =
  | Readonly<{ _tag: "unstated" }>
  | Readonly<{ _tag: "na"; reason: string }>
  | Readonly<{ _tag: "hold" }>
  | Readonly<{ _tag: "owed"; by: string }>;

export type KillerKind = "test" | "bug" | "mutant";

// What fails when the rule is broken: a test, a planted bug file or a mutant. `owed` names who brings it.
export type Killer = Readonly<{
  kind: KillerKind;
  layer: Layer;
  name: string;
  owed?: string;
}>;

export type Row = Readonly<{
  id: string;
  statement: string;
  source: string;
  cells: Readonly<Record<Layer, Cell>>;
  killers: readonly Killer[];
  // A retired rule is kept, pointing at its successors. It needs no killer and claims no layer.
  retiredBy?: readonly string[];
}>;

export type Register = readonly Row[];

// What a layer's checks are called. The gate reads these, never comments.
export type NameKind =
  | "title"
  | "function"
  | "contract"
  | "file"
  | "property"
  | "bug"
  | "mutant"
  | "run"
  | "invariant";

export type Name = Readonly<{ layer: Layer; kind: NameKind; text: string; file: string }>;

export type Problem =
  | Readonly<{ _tag: "DuplicateId"; id: string }>
  | Readonly<{ _tag: "MissingInLayer"; id: string; layer: Layer }>
  | Readonly<{ _tag: "OwedButPresent"; id: string; layer: Layer; by: string }>
  | Readonly<{ _tag: "UnstatedCell"; id: string; layer: Layer }>
  | Readonly<{ _tag: "NotApplicableButPresent"; id: string; layer: Layer; reason: string }>
  | Readonly<{ _tag: "NoKiller"; id: string }>
  | Readonly<{ _tag: "UnknownSuccessor"; id: string; successor: string }>
  | Readonly<{ _tag: "RowRemoved"; id: string }>
  | Readonly<{ _tag: "CellWeakened"; id: string; layer: Layer; from: Cell["_tag"]; to: Cell["_tag"] }>
  | Readonly<{ _tag: "KillerDropped"; id: string; killer: Killer }>
  | Readonly<{ _tag: "KillerNotFound"; id: string; killer: Killer }>
  | Readonly<{ _tag: "KillerInUnclaimedLayer"; id: string; killer: Killer }>
  | Readonly<{ _tag: "KillerOwedButPresent"; id: string; killer: Killer; owed: string }>;

export const describeProblem = (problem: Problem): string => {
  switch (problem._tag) {
    case "DuplicateId":
      return `${problem.id}: listed twice in the register`;
    case "MissingInLayer":
      return `${problem.id}: no ${problem.layer} name carries the id (cell is "hold")`;
    case "OwedButPresent":
      return `${problem.id}: ${problem.layer} already carries the id; promote "owed: ${problem.by}" to "hold"`;
    case "UnstatedCell":
      return `${problem.id}: the ${problem.layer} cell is not stated; say "hold", "owed: <who brings it>" or "n/a: <why this layer has no part in the rule>"`;
    case "NotApplicableButPresent":
      return `${problem.id}: the ${problem.layer} cell says "n/a: ${problem.reason}", but a ${problem.layer} name carries the id; make the cell "hold"`;
    case "NoKiller":
      return `${problem.id}: the row names no killer`;
    case "UnknownSuccessor":
      return `${problem.id}: retired_by names ${problem.successor}, which is not a live row`;
    case "KillerNotFound":
      return `${problem.id}: killer "${problem.killer.name}" (${problem.killer.kind}, ${problem.killer.layer}) is not among the names`;
    case "KillerInUnclaimedLayer":
      return `${problem.id}: killer "${problem.killer.name}" is in the ${problem.killer.layer} layer, where this row holds nothing (the cell is n/a or unstated)`;
    case "RowRemoved":
      return `${problem.id}: the row was in the base register and is gone (retire it with retired_by instead)`;
    case "CellWeakened":
      return `${problem.id}: the ${problem.layer} cell went from ${problem.from} to ${problem.to}; a claim may only grow`;
    case "KillerDropped":
      return `${problem.id}: killer "${problem.killer.name}" (${problem.killer.kind}, ${problem.killer.layer}) was in the base register and is gone`;
    case "KillerOwedButPresent":
      return `${problem.id}: killer "${problem.killer.name}" exists now; drop its "owed: ${problem.owed}"`;
    default:
      return unhandled(problem);
  }
};

// The compiler proves this unreachable; if a variant is ever added without a case, the text says which.
const unhandled = (problem: never): string => `unhandled problem ${JSON.stringify(problem)}`;

// A record with one entry per layer, built from a function of the layer: no cast, and a new layer is a type error.
export const byLayer = <T>(of: (layer: Layer) => T): Readonly<Record<Layer, T>> => ({
  arrival: of("arrival"),
  quint: of("quint"),
  contract: of("contract"),
  rig: of("rig"),
  ts: of("ts"),
});
