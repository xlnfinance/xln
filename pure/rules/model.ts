// The rule register's vocabulary: layers, cells, killers, rows, and what the gate can say about them.
// Everything here is data and total functions. Reading files and exiting happen in check.ts.

export type Layer = "arrival" | "quint" | "contract" | "rig" | "ts";

export const LAYERS: readonly Layer[] = ["arrival", "quint", "contract", "rig", "ts"];

// A cell says what one layer owes one rule.
//   absent  the layer does not hold this rule (or no slice has claimed it yet); nothing is checked
//   hold    a name in this layer must carry the id; the gate fails when none does
//   owed    the layer must hold it, but a named PR or slice brings the name; shown as open, never hidden
export type Cell =
  | Readonly<{ _tag: "absent" }>
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
  | "def";

export type Name = Readonly<{ layer: Layer; kind: NameKind; text: string; file: string }>;

export type Problem =
  | Readonly<{ _tag: "DuplicateId"; id: string }>
  | Readonly<{ _tag: "MissingInLayer"; id: string; layer: Layer }>
  | Readonly<{ _tag: "OwedButPresent"; id: string; layer: Layer; by: string }>
  | Readonly<{ _tag: "NoKiller"; id: string }>
  | Readonly<{ _tag: "KillerNotFound"; id: string; killer: Killer }>
  | Readonly<{ _tag: "KillerOwedButPresent"; id: string; killer: Killer; owed: string }>;

export const describeProblem = (problem: Problem): string => {
  switch (problem._tag) {
    case "DuplicateId":
      return `${problem.id}: listed twice in the register`;
    case "MissingInLayer":
      return `${problem.id}: no ${problem.layer} name carries the id (cell is "hold")`;
    case "OwedButPresent":
      return `${problem.id}: ${problem.layer} already carries the id; promote "owed: ${problem.by}" to "hold"`;
    case "NoKiller":
      return `${problem.id}: the row names no killer`;
    case "KillerNotFound":
      return `${problem.id}: killer "${problem.killer.name}" (${problem.killer.kind}, ${problem.killer.layer}) is not among the names`;
    case "KillerOwedButPresent":
      return `${problem.id}: killer "${problem.killer.name}" exists now; drop its "owed: ${problem.owed}"`;
    default:
      return assertNever(problem);
  }
};

export const assertNever = (value: never): never => {
  // The type system makes this unreachable; reaching it is a broken build, not a peer input.
  throw new Error(`unhandled variant: ${JSON.stringify(value)}`);
};
