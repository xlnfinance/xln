# xln spec

The xln protocol spec, written in [Arrival](https://github.com/here-build/arrival): a sandboxed
R7RS Scheme for agents. A spec page describes the protocol as rules over a world and properties
that must hold; it does not implement it. An explicit-state checker walks every reachable world of
a page and reports the first property that breaks, with the trace that breaks it.

## Layout

```
spec/
  arrival/                 Arrival, vendored from here-build/arrival@6ba2b54f (see "Vendored Arrival")
  arrival.config.json      arms define/overridable for the CLI (run from spec/)
  lib/vocabulary.scm       `rule` and `property`: how a page names its parts
  lib/check.scm            `check`: breadth-first walk of every reachable world
  account/frames.scm       Account frames: propose, ack, cross-open tie-break (Left wins)
  account/clock.scm        a frame's timestamp carries no authority (R-CLOCK); every HTLC time judgment is in J height by the party's own view, strict expiry bound with a reserve >= LAG, payee reveals at deadline - LAG (R-HTLC-CLOCK)
  account/bugs/*.scm       deliberately broken variants; the checker must catch each
  account/swap.scm         a two-party swap inside an Account: offer, partial fill (a ratio of 65535, each leg floors), withdraw, lapse (off-chain expiry), the signed clause that shrinks with every fill (R-SWAP-CLAUSE-WITH-FILL), and a dispute that honours what was filled (R-SWAP-ONCHAIN)
  money/core.scm           the arithmetic both money pages share: payment, worst-case credit bound, deposit (composition)
  money/ledger.scm         the money of one Account: RCPAN credit bound in the worst case, conservation
  money/bugs/*.scm         planted money bugs
  dispute/dispute.scm      one dispute: stale start, counter, three finalize paths, payout, debt, epoch, the implicit proof of each new epoch (R-IMPLICIT-BASELINE), per-proof windows, settlement, deposits, H1-H4
  dispute/bugs/*.scm       planted dispute bugs
  */configs/*.scm          second bounds and findings: extra files loaded after the page (dispute: retired boards, two disputes in a row from the implicit proof, a window policy that lengthens, ...)
  entity/consensus.scm     Entity consensus: leader, quorum, own proposal vs certified frame (R-E3)
  entity/bugs/*.scm        planted consensus bugs
  entity/frame.scm         the Entity frame: four phases, one view, hooks before txs, first-touch proposals
  entity/bugs/*.scm        (also the frame's planted bugs)
  runtime/tick.scm         the Runtime tick: apply, commit, flush, crash, replay; what may halt
  runtime/bugs/*.scm       planted Runtime bugs
  entity/routing.scm       a hub forwarding one HTLC: HOP margin (R1), fail-back wait (R2), a dispute publishes every known secret (R3)
  transport/link.scm       the node-to-node link (T0): a message, the weakest channel, addressing, sender check, refusal never halts, persist before send and before ack
  transport/bugs/*.scm     planted link bugs; transport/configs/ has witnesses that each refusal path is reachable, and the no-halt-flag run
  j/batch.scm              the J batch: atomic chain, sealing, abort and abandon (a signed batch is final at its nonce), skipped dispute ops, R-J5/R-COSIGN/J6 batch rules, paused-token deposits and funded payments, FIFO debt enforcement, gas by batch kind, settlement debt forgiveness, refusal when full
  j/bugs/*.scm             planted J batch bugs
  account-frames.check.scm entry point: check the Account frames page
  account-swap.check.scm   entry point: check the swap page
  entity-frame.check.scm   entry point: check the Entity frame page
  runtime.check.scm        entry point: check the Runtime page
  transport.check.scm      entry point: check the transport link page
  j-batch.check.scm        entry point: check the J batch page
  entity-consensus.check.scm entry point: check the Entity consensus page
  entity-routing.check.scm entry point: check the routing page
  dispute.check.scm        entry point: check the dispute page
  ledger.check.scm         entry point: check the ledger page
  test.mjs                 runs the page and every bug variant in parallel, asserts the verdicts
  export-traces.mjs        complete runs as ITF JSON into traces/ (for the Quint replay)
  QUESTIONS.md             every open point and the reading taken
  mcp/server.mjs           MCP server: lets an agent run and check Arrival programs here
```

## Run

Needs Node 20+, pnpm (`corepack enable`) and npm or bun.

```sh
cd spec
npm install            # or: bun install    (MCP server dependencies; `npm ci` in a boot script)
npm run setup          # pnpm install + build inside arrival/ (dist/ is not committed)
npm run check          # about 2 minutes: {:ok #t :states 3651 :transitions 11335 :goals 16}
npm test               # 208 cases, one child process each (pool of TEST_JOBS=4), each verdict printed as its case finishes; exits non-zero if any case fails.
                       # Wall time 88.7 minutes on 4 cores (the J batch case with deposit legs alone takes 85); every case has a fixed budget (150 minutes) and fails by name if it blows it
```

Run any file directly: `node arrival/packages/arrival-cli/dist/cli.js run <file.scm>` from `spec/`.
`(require "lib/check.scm")` resolves against the directory of the entry file, so run from `spec/`.

## Writing a page

A page exports one dict for the checker (see the end of `account/frames.scm`):

```scheme
(define account-frames
  (dict :init init              ; the starting world
        :next next              ; world -> labelled successor worlds, built by `successors` from rules
        :invariants invariants  ; properties that hold in every reachable world
        :at-rest at-rest))      ; properties that hold wherever no rule applies
```

Rules and properties are named data:

```scheme
(rule "propose" (w side)
  (when (can-propose? w side))
  (then (propose w side)))

(property "committed histories agree: one extends the other" (w)
  (or (extends? (head-of w :left) (head-of w :right))
      (extends? (head-of w :right) (head-of w :left))))
```

- `(when …)` is the guard, `(then …)` the next world. Both are pure; there is no `set!`.
- The walk is breadth-first, so a reported trace is a shortest one.
- Model bounds are `define/overridable` with an `s/*` schema, so a run can widen them without editing
  the page. Put the override in a config file and pass it: `--config wide.json` with
  `{"capabilities":[{"module":"./arrival/packages/arrival/dist/env/overridable/overridable.js",
  "config":{"params":{"right-txs":["x","y","z"]}}}]}` (a larger model takes minutes).
- `arrival_check` and `arrival check` on a page file report false unbound names (`rule`, `check`),
  because a page relies on the entry file's `(require …)`. Check entry files (`*.check.scm`).
- Numbers are exact and unbounded: `(- (expt 2 256) 1)` is exact. Use them for amounts.

## Vendored Arrival

`arrival/` is here-build/arrival at 6ba2b54f (MIT), imported verbatim in one commit. Local patches,
each with tests, sit in later commits so they can be sent upstream:

1. Macros through the public `exec`: `syntax-rules` templates that used a kernel keyword such as
   `lambda` failed with `Unbound variable Symbol(#:lambda)` (`src/eval/Resolver.ts`).
2. Keywords in macro templates (`:name`) are no longer renamed by hygiene (`src/eval/syntax-rules.ts`).
3. Static validation sees names bound by `define/overridable` (`src/static-validation/`).
4. Exact integers are bigints: exact arithmetic never overflows; the reader, `number->string`, the
   JS membrane and the zod codecs carry bigints (`src/values/`, `src/env/r7rs/numeric.ts`). Exact
   vs inexact comparison is exact, which also fixes chibi r7rs-tests line 811.
5. `%dict-set` is native (`src/env/polyglot/polyglot-clojure.ts`): `assoc-in` and `update-in` on a
   17-field dict went from about 0.8 ms to 0.1 ms, which is the inner loop of the state-space checker.
   Same semantics: an existing key keeps its position, a new key goes last.
6. `vendor/chibi-scheme/` holds the two chibi test files (BSD-3) the conformance suite reads.

Arrival suite after the patches: 5382 pass, 160 expected-fail, 6 fail; package lint 0 errors, 104 warnings (same as upstream). The 6 are the `grammar-ebnf` package-export
tests, which fail the same way on upstream 6ba2b54f.

Known gap, upstream too: a `define` produced by a macro expansion is not visible to later top-level
forms. Pages define with plain `define`.

## MCP server

`mcp/server.mjs` is a stdio MCP server named `arrival-xln-spec`. Tools:

| tool             | does                                                                  |
|------------------|-----------------------------------------------------------------------|
| `arrival_run`    | runs a `.scm` file under `spec/`, or a code snippet evaluated from `spec/` |
| `arrival_check`  | static diagnostics (unbound names, misuse, each with its fix), no evaluation |
| `arrival_guide`  | the Arrival language card, then this README                          |

Paths are confined to `spec/`. It shells out to the built CLI, so run the setup above first.

### Claude Code

The repo's `.mcp.json` already registers it as `arrival`, relative to the repo root. After
`npm install && npm run setup` in `spec/`, start Claude Code from the repo root and approve the
server when asked; `/mcp` shows its state. To add it yourself instead:

```sh
claude mcp add arrival -- node spec/mcp/server.mjs            # this checkout, only you
claude mcp add -s user arrival -- node /abs/path/og_xln/spec/mcp/server.mjs   # every project
```

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows:
`%APPDATA%\Claude\`), use absolute paths, then restart the app:

```json
{
  "mcpServers": {
    "arrival": {
      "command": "node",
      "args": ["/abs/path/og_xln/spec/mcp/server.mjs"]
    }
  }
}
```

If `node` is not on the app's PATH, put the absolute path of `node` in `command`.

### Checking it works

Ask the agent to call `arrival_run` with `file: "account-frames.check.scm"`; it should print
`{:ok #t :states 3651 :transitions 11335 :goals 16}`. Without an MCP client:

```sh
npx @modelcontextprotocol/inspector node spec/mcp/server.mjs
```

If the server fails to start, the usual cause is a missing build: `arrival/packages/arrival-cli/dist/cli.js`
must exist (`npm run setup`), and `spec/node_modules` must exist (`npm install`).

## Traces

`node export-traces.mjs [page] [count]` writes complete runs of a page as ITF JSON (Quint's
trace format) into `traces/<page>/`, shortest first. `mbt::actionTaken` names the rule of each
step. A thread with the independent Quint spec replays them there.

## Questions

Every open point and the reading the spec took is in `QUESTIONS.md`.

Lockfiles: `package-lock.json` (npm) and `bun.lock` (bun) pin the same versions of the MCP server
dependencies, so `npm install` gives the same tree on every boot. When you change `spec/package.json`,
update both files.
