// What ast-grep cannot count in the new tree (kernel/, chain/): long lines, long declarations and exports nothing
// uses, and the comparison of every hit with the registered exceptions. Text in, hits and rows out.
export type Hit = Readonly<{ ruleId: string; file: string }>;
export type Row = Readonly<{ rule: string; file: string; now: number; allowed: number }>;
export type Exceptions = Readonly<Record<string, Readonly<Record<string, number>>>>;

export const MAX_LINE = 120;
export const MAX_DECLARATION_LINES = 50;

export const longLines = (file: string, text: string): readonly Hit[] =>
  text.split("\n").filter((line) => line.length > MAX_LINE).map((): Hit => ({ ruleId: "long-line", file }));

const opensDeclaration = (line: string): boolean => /^(export )?(const|function|type) /.test(line);
const endsDeclaration = (line: string): boolean => line.length > 0 && !" })];*".includes(line[0] ?? " ");

// A declaration runs from its first line to the last line before the next line that starts in column 0.
export const declarationSpans = (text: string): readonly number[] => {
  const lines = text.split("\n");
  return lines.flatMap((line, start) => {
    if (!opensDeclaration(line)) return [];
    const next = lines.findIndex((other, index) => index > start && endsDeclaration(other));
    return [(next < 0 ? lines.length : next) - start];
  });
};

export const longDeclarations = (file: string, text: string): readonly Hit[] =>
  declarationSpans(text).filter((span) => span > MAX_DECLARATION_LINES).map((): Hit => ({ ruleId: "long-declaration", file }));

export type Export = Readonly<{ name: string; isType: boolean }>;

export const exportsOf = (text: string): readonly Export[] =>
  [...text.matchAll(/^export (const|function|type) ([A-Za-z_$][\w$]*)/gm)].map((found) => ({ name: found[2] ?? "", isType: found[1] === "type" }));

const mentions = (text: string, name: string): number => (text.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;

// A value export needs a user in another file; a type export is also live when its own file names it in a signature.
export const isLive = (own: string, { name, isType }: Export, others: readonly ReadonlySet<string>[]): boolean =>
  others.some((words) => words.has(name)) || (isType && mentions(own, name) > 1);

export const wordsOf = (text: string): ReadonlySet<string> => new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);

export const deadExports = (file: string, text: string, others: readonly ReadonlySet<string>[]): readonly Hit[] =>
  exportsOf(text).filter((each) => !isLive(text, each, others)).map((each): Hit => ({ ruleId: "unreachable", file: `${file} (${each.name})` }));

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
