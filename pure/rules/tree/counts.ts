// What ast-grep cannot count in the new tree (kernel/, chain/) from a single rule: long lines, and the comparison of
// every hit with the registered exceptions. Declarations and exports are read from syntax in syntax.ts.
export type Hit = Readonly<{ ruleId: string; file: string }>;
export type Row = Readonly<{ rule: string; file: string; now: number; allowed: number }>;
export type Exceptions = Readonly<Record<string, Readonly<Record<string, number>>>>;

export const MAX_LINE = 120;
export const MAX_DECLARATION_LINES = 50;

export const longLines = (file: string, text: string): readonly Hit[] =>
  text.split("\n").filter((line) => line.length > MAX_LINE).map((): Hit => ({ ruleId: "long-line", file }));

const cell = (rule: string, file: string): string => `${rule}\t${file}`;

// Every hit counted against its exception, plus each exception no hit uses (an exception cannot outlive its cause).
export const compare = (hits: readonly Hit[], exceptions: Exceptions): readonly Row[] => {
  const counted = [...Map.groupBy(hits, (hit) => cell(hit.ruleId, hit.file))].map(([key, group]): Row => {
    const [rule = "", file = ""] = key.split("\t");
    return { rule, file, now: group.length, allowed: exceptions[rule]?.[file] ?? 0 };
  });
  const unused = Object.entries(exceptions).flatMap(([rule, byFile]) =>
    Object.entries(byFile)
      .filter(([file]) => !counted.some((row) => row.rule === rule && row.file === file))
      .map(([file, allowed]): Row => ({ rule, file, now: 0, allowed })));
  return [...counted, ...unused].toSorted((a, b) => cell(a.rule, a.file).localeCompare(cell(b.rule, b.file)));
};

// More hits than allowed is a violation; fewer is a stale exception. Both fail, so a waiver cannot outlive its cause.
export const isOff = (row: Row): boolean => row.now !== row.allowed;
