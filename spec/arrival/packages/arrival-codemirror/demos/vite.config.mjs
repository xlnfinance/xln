// Vite config for the demos — plain object (no `defineConfig` import) so a
// one-off `pnpm dlx vite demos` works without vite installed locally.
//
// The one non-default piece: demos import the package by its PUBLIC name
// (copy-pasteable), so the self-name aliases to ./src here. In your own app
// you install @inhuman.tools/arrival-codemirror and delete the aliases.

const src = new URL("../src/", import.meta.url).pathname;

export default {
  resolve: {
    alias: [
      { find: "@inhuman.tools/arrival-codemirror/react", replacement: `${src}react/index.ts` },
      { find: "@inhuman.tools/arrival-codemirror", replacement: `${src}index.ts` },
    ],
  },
  plugins: [
    {
      // arrival-lsp's browser entry pulls TypeScript's stock lib.*.d.ts
      // and its prelude via `import.meta.glob(…, { query: "?raw" })`. Two
      // vite-7 shims: (a) bare globs must start with '/' or './' — rewrite the
      // typescript one relative to the importing file (dist/ → the package's
      // own `typescript` dep); (b) eager `?raw` globs need `import: "default"`
      // to yield strings rather than module objects.
      name: "type-lens-glob-shim",
      enforce: "pre",
      transform(code, id) {
        if (!id.includes("arrival-lsp") || !code.includes('query: "?raw"')) return null;
        return code
          .replaceAll('import.meta.glob("typescript/lib/', 'import.meta.glob("../node_modules/typescript/lib/')
          .replaceAll('{ eager: true, query: "?raw" }', '{ eager: true, query: "?raw", import: "default" }');
      },
    },
  ],
};
