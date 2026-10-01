// How the parts of `bun rules/check.ts` become one exit code. A part that did not run (the matrix view skips the
// style, width and findings parts) is passed in as true; a part that ran and found something is false.
export type GateParts = Readonly<{ register: boolean; style: boolean; width: boolean; findings: boolean }>;

export const gateExit = (parts: GateParts): 0 | 1 => (parts.register && parts.style && parts.width && parts.findings ? 0 : 1);

export type Part = "register" | "style" | "width" | "findings";

// Which parts a command line runs: the part a --X-only flag names, or (with no such flag) every part, except that the
// matrix view keeps to the register. A part that is not wanted counts as passed in `gateExit`.
export type Selection = Readonly<{ only: Part | undefined; matrixOnly: boolean }>;

const ONLY_FLAGS: Readonly<Record<string, Part>> = { "--register-only": "register", "--style-only": "style", "--width-only": "width", "--findings-only": "findings" };

export const selectionOf = (args: readonly string[]): Selection => ({
  only: args.map((arg) => ONLY_FLAGS[arg]).find((part) => part !== undefined),
  matrixOnly: args.includes("--matrix"),
});

export const isWanted = (part: Part, { only, matrixOnly }: Selection): boolean =>
  only === undefined ? part === "register" || !matrixOnly : only === part;
