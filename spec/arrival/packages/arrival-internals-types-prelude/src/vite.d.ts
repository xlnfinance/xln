// Vite-style raw asset imports — the build-time typing for the browser entry.
//
// `./browser.ts` loads the prelude `.d.ts` via a relative `import.meta.glob` with
// `query: "?raw"`. Both the `*?raw` module shape and `import.meta.glob` are
// resolved and INLINED by this package's own `vite build`, so dist ships plain
// strings — consumers never see a `?raw` specifier or a glob.
declare module "*?raw" {
  const content: string;
  export default content;
}

// Vite's `import.meta.glob` used for direct asset loading in the browser entry.
// `import: "default"` (with eager `?raw` globs) unwraps the module to the string.
interface ImportMeta {
  glob: (
    pattern: string,
    options?: { eager?: boolean; query?: string | Record<string, unknown>; import?: string },
  ) => Record<string, unknown>;
}
