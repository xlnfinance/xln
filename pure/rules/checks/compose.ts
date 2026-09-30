// How the parts of `bun rules/check.ts` become one exit code. A part that did not run (the matrix view skips the
// style and width parts) is passed in as true; a part that ran and found something is false.
export type GateParts = Readonly<{ register: boolean; style: boolean; width: boolean }>;

export const gateExit = (parts: GateParts): 0 | 1 => (parts.register && parts.style && parts.width ? 0 : 1);
