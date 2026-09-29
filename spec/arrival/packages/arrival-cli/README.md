# @inhuman.tools/arrival-cli

**The `arrival` command** — run, static-check, and REPL [arrival](https://www.npmjs.com/package/@inhuman.tools/arrival)
programs from the terminal. This page documents the CLI's process surface — argv, stdin, stdout/stderr,
exit codes; the language itself (the membrane, provenance, capabilities) is `@inhuman.tools/arrival`'s README.

## Install

```sh
npm install -g @inhuman.tools/arrival-cli   # installs the `arrival` bin
arrival --help

npx @inhuman.tools/arrival-cli --help       # same surface, no global install
```

## Running programs — values ARE the output

```scheme
; hello.scm
(define subject "world")
(string-append "hello, " subject)
```

```
$ arrival run hello.scm
"hello, world"
```

arrival is a pure inference plane: there is **no `display`, no `format`, no ports** — deliberately, not
as a gap (an ambient write has no value-construction site for provenance; the full argument is in the
core README). Your program's output is its **values**: `run` prints each non-`define` top-level form's
value to stdout, one per line; `define` forms print nothing.

Reach for `(display …)` anyway and the door teaches the model back:

```
$ arrival run print.scm
error: `display @ scheme/r7rs/host` is not available in this assembly — ports & IO are
omitted from arrival by design — it is a pure inference plane with no IO surface; an
ambient read/write has no value-construction site for provenance. Return the value from
your dataflow instead of streaming it out. Referenced at 1:0 — this program would crash there.
```

(exit 1, and — because validation runs before execution — nothing was evaluated.)

**Rendering.** Values print as s-expression text through `@inhuman.tools/arrival-serializer`, budget-bounded
(long structures shrink fairly, never tail-cut): `(filter (lambda (x) (> x 5)) (list 1 3 7 9 2))` prints
`[7 9]`. Quoting is serializer rules (spaces and specials), not computed-vs-literal: `"hello, world"`
is quoted because of the space and comma; a simple token like `done` is not. Don't parse quoting as a
type signal.

```
arrival run <file.scm>       validate, then execute — exactly one file; prints each top-level form's value
arrival check <file.scm> […] static diagnostics only, every listed file — no Scheme is evaluated
arrival repl                 interactive session — persistent defines, Ctrl-D exits
```

## Static validation — the whole program, before the first form runs

`run` validates the complete program against the assembled vocabulary first (the eslint-style pass) and
refuses to execute a program that would crash — every diagnostic at once, each with its cure:

```
$ arrival run typo.scm
error: Unbound symbol `fliter` Referenced at 1:0 — this program would crash there.
```

`arrival check` is that pass **alone** — nothing evaluates. Unlike `run` (exactly one file), `check`
takes any number of files:

```
$ arrival check ticket.scm more.scm
ticket.scm: ok
more.scm: ok
```

Every listed file is checked (no fail-fast — CI wants the complete list); output is per-file; exit is 1
iff **any** file has an error-tier diagnostic. One caveat for security-sensitive CI: "nothing is
evaluated" is true for the Scheme — but `--with` / config-file capability modules are host JS that **is
imported and executed** to arm the vocabulary (see below).

## Machine output and run introspection

`run --json` opts stdout's _values_ into NDJSON (one JSON value per top-level form, for `| jq` and
agent consumers) instead of the default s-expr text:

```
$ arrival run --json hello.scm
"hello, world"
```

Three more `run` flags tap the same execution trace to answer "what actually happened" — all to
**stderr**, never stdout, so they compose with piped values:

- `--outline` — after the run, a source-ordered outline of every form that executed, each with its
  state and its invocation `×count` (the dynamic multiplicity behind that form — `(fib 10)` reports
  hundreds of invocations across a handful of forms).
- `--form <scope>` — drill into one form by its `scopeId` (the `head@line:col` shown in
  `--outline`): its invocation aggregate, callers, sampled values.
- `--export` — emit the run introspection as one versioned JSON object on stdout (forms + counts +
  states + total invocations — the machine/agent contract); this **replaces** the normal value
  output rather than joining it.

The module headers (`run-view.ts`, `run-outline.ts`, `form-detail.ts`, `run-export.ts`) carry the
mechanics.

## Modules — `(require "file.scm")`

`(require …)` loads a file **relative to the entry file's directory** (the require root is jailed there;
`..` escapes are refused), evaluates it in the running session, and every top-level `define` it makes
becomes visible. There is **no `provide`/`export`** — all top-level defines spill, by design.

```scheme
; lib.scm                        ; main.scm
(define (hello) "hi from lib")   (require "lib.scm")
                                 (hello)
```

```
$ arrival run main.scm
note: static validation skipped — (require …) bindings are invisible to the pass; runtime doors remain the backstop.
"hi from lib"
```

That note is load-bearing: **a require-using program skips static validation entirely** (the pass can't
see require-spilled names, and would false-fail on every one), and `check` reports it `skipped` rather
than pretending coverage. Runtime doors remain the backstop. For full static coverage, keep programs
single-file or gate the require-free ones in CI.

## Capabilities — arming tools with `--with` and `arrival.config`

The host (you) arms capabilities; programs can never grant themselves authority. A capability module is
any ES module exporting `EnvCapability` instance(s):

```js
// jira.mjs
import { EnvCapability } from "@inhuman.tools/arrival/capability";

export default EnvCapability.define("demo/jira", {
  symbols: (symbol, z) => ({
    "jira-ticket": symbol.rosetta`jira-ticket: fetch one ticket by key`(
      { input: [z.string], output: [z.string] },
      async (key) => `[${key}] Fix the flux capacitor`, // any real fetch goes here
    ),
  }),
});
```

**Armed verbs bind as bare Scheme symbols.** There is no `tool-call`, no `primitive-ref`, no dispatch
indirection — the verb's declared name IS the identifier:

```scheme
; ticket.scm
(jira-ticket "ACME-1")
```

```
$ arrival run --with ./jira.mjs ticket.scm
"[ACME-1] Fix the flux capacitor"
```

And `check` validates against the **armed** vocabulary — a typo'd or un-armed verb is a diagnostic
before anything runs:

```
$ arrival check --with ./jira.mjs ticket.scm
ticket.scm: ok
$ arrival check ticket.scm
ticket.scm:
error: Unbound symbol `jira-ticket` Referenced at 1:0 — this program would crash there.
1 problem (1 error)
```

Two sharp edges, stated plainly:

- **The `./` prefix is required for local files** (ESM resolution rules): `--with ./jira.mjs` is a path;
  `--with jira.mjs` is a _bare npm specifier_ and fails with `cannot load … Cannot find package`. Paths
  resolve from the **cwd you invoke from**, not the script's directory.
- **The module resolves its own imports from its own location** — `jira.mjs` must be able to resolve
  `@inhuman.tools/arrival` from where it sits (a project with the dependency installed). A stray file in a
  bare directory fails with `cannot load`.

**The config file** replaces repeated flags: `arrival.config.ts` / `arrival.config.json` auto-discovers
from cwd (`--config <file>` overrides; module specifiers inside resolve relative to the file):

```json
{ "capabilities": [{ "module": "./jira.mjs", "config": { "baseUrl": "…" } }], "config": {} }
```

Per-entry `config` slices merge into the one shared bag (later entries win key-wise); each capability
validates its own slice. `--with` modules append after the config file's. A `.ts` config loads via
node's native type-stripping (node ≥ 23.6; older node gets a teaching error pointing at `.json`).

## Passing data in

Parameterized data is not a CLI flag yet; use the `@inhuman.tools/arrival` API.

## REPL

`arrival repl` is one persistent session: defines accumulate across turns, an error prints its teaching
door on stderr and the session survives, multi-line forms continue until parens balance (the reader's own
scanner, not a hand-rolled counter), Ctrl-D exits.

On a TTY you get the full experience — a shibboleth quote as the splash (not a wordmark;
`--banner wordmark` / `ARRIVAL_BANNER=wordmark` brings the gradient back; `--banner off` is
silent), provenance-tinted per-form cascade, and the **sugarcoat lens on by default**
(scrollback renders in sugarcoat's JS/Python-shaped face; type `,lens` to flip to Scheme
and back). Piped/non-TTY input is the plain contract — no ANSI, one value per form:

```
$ printf '(define x 21)\n(* x 2)\n' | arrival repl
42
```

`repl` takes `--with`/`--config` too; the whole session sees one armed vocabulary.

## Exit codes

| code | meaning                                                                                      |
| ---- | -------------------------------------------------------------------------------------------- |
| 0    | `run`: executed clean · `check`: no error-tier diagnostics in ANY file · `repl`: clean exit  |
| 1    | `run`: validation or runtime error (doors on stderr) · `check`: at least one file has errors |
| 2    | usage: missing/extra positionals, unknown command (usage text on stderr)                     |

Diagnostics go to **stdout** for `check` (they are its product, still human-teaching prose — not a
stable machine format) and to **stderr** for `run` (stdout is reserved for your program's values —
shell-capture `$(arrival run …)` gets values only). `run --json` opts the _values_ into a machine
format (see "Machine output and run introspection" above); `check`'s diagnostic text has no such
switch yet. Gate CI on exit codes.

## Budgets

Every verb runs bounded, tunable by environment variable:

| var                     | default  | meaning                               |
| ----------------------- | -------- | ------------------------------------- |
| `ARRIVAL_RUN_BUDGET_MS` | `300000` | per-run wall-clock budget (5 minutes) |

A breach is a plain error (exit 1), e.g. `execution budget exceeded (49.97ms)`.

## CI recipe

```sh
arrival check --with ./caps.mjs src/*.scm     # every file checked, per-file report, exit 1 on any error
```

Remember the two coverage holes named above: require-using files are `skipped` (not validated), and the
capability module itself executes during `check`.

## License

[MIT](./LICENSE.md).
