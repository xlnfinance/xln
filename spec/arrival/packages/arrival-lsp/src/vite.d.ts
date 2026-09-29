// Vite-style raw asset imports.
//
// This lets us load TypeScript's stock lib/*.d.ts files via the generated
// explicit-`?raw` barrel (`src/ts-libs-raw.generated.ts`) and the prelude via a
// relative `import.meta.glob`. Both are resolved and INLINED by this package's
// own `vite build` of the browser/worker entries, so dist ships plain strings —
// consumers never see a `?raw` specifier or a glob.
//
// (Vite 7 bans bare-package glob patterns everywhere, hence the barrel of
// explicit imports for typescript/lib; bare `?raw` IMPORTS remain legal.)
declare module "*?raw" {
  const content: string;
  export default content;
}

// Support for Vite's import.meta.glob used for direct asset loading in browser entry.
// `import: "default"` (used with eager ?raw globs) unwraps the module to the string.
interface ImportMeta {
  glob: (
    pattern: string,
    options?: { eager?: boolean; query?: string | Record<string, any>; import?: string },
  ) => Record<string, any>;
}
