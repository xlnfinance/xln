# Demos

Three minimal setups, importing the package by its public name. All three typecheck against the
source (`pnpm typecheck` at the package root covers them); the first two run in a browser as-is.

| File                                       | Shows                                                                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`vanilla-ide.ts`](./vanilla-ide.ts)       | Vanilla CM6: language + paredit + inlay hints + the full tsc-backed IDE (in-process browser service). The seeded `(greet 42)` carries a real type error. |
| [`sugarcoat-flip.ts`](./sugarcoat-flip.ts) | One program, two faces: Scheme and Sugarcoat side by side, the _same_ backend mounted on both — Sugarcoat through `sugarcoatIdeBackend`.                 |
| [`react-editor.tsx`](./react-editor.tsx)   | `<SchemeEditor>` with the scheme/sugarcoat lens switch, parse-state reporting, structural editing, and the self-loading worker-ladder IDE.               |

## Run

```bash
pnpm install            # workspace deps
pnpm demo               # → http://localhost:5173  (vanilla + sugarcoat flip)
pnpm storybook          # → http://localhost:6011  (React SchemeEditor live IDE)
```

`index.html` mounts demos 1 and 2. The React demo is a component to drop into any React 19 app —
its worker rungs need a bundler that understands `new Worker(new URL(...), import.meta.url)`
(vite, webpack 5); elsewhere the backend ladder degrades to the in-thread rung by itself.

`vite.config.mjs` exists only to alias the package's own name to `./src` inside this repo — in
your app you install the package and need none of it.
