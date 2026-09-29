#!/usr/bin/env node
/**
 * The `arrival` command — three verbs over the public exec surface:
 *
 *   arrival run <file.scm>    parse → whole-program static validation (the eslint-style
 *                             pass, staticValidation:"on") → execute with the loader
 *                             capability rooted at the file's dir, budgets bounded;
 *                             one printed value per top-level form.
 *   arrival repl              persistent-scope readline session (see repl.ts).
 *   arrival check <file.scm>  the validation pass ALONE — the complete Diagnostic list,
 *                             exit 1 iff any error-tier diagnostic; NOTHING evaluates.
 *
 * `check` needs validate-without-execute, and the public surface deliberately keeps
 * vocabulary assembly inside `execState` (the sealed chain isn't exported). The honest
 * public-API cut: run `execState({ staticValidation: "on" })` with an ALREADY-ABORTED
 * signal whose reason is our sentinel — the trampoline fast-fails BEFORE the first
 * form's first step (evaluator.ts run(): "if the caller passed an already-aborted
 * signal, refuse"), so validation completes and zero evaluation happens, by the
 * evaluator's own contract rather than a re-implementation of its assembly.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { disposeRunContext, exec, execState, LexicalScope } from "@inhuman.tools/arrival";
import { StaticValidationError } from "@inhuman.tools/arrival/lsp-internals";
import { EvalTrace } from "@inhuman.tools/arrival/provenance";

import { armCapabilities, type ArmedCapabilities } from "./capabilities.js";
import { resolveOutputMode, type OutputMode } from "./output-mode.js";
import { repl } from "./repl.js";
import { formDetail, renderFormDetail } from "./form-detail.js";
import { exportRun } from "./run-export.js";
import { renderRunOutline } from "./run-outline.js";
import { runView } from "./run-view.js";
import { attuneTerminal, paint, streamColorMode, type ColorMode } from "./tints.js";
import {
  budgets,
  loaderSession,
  paintDiagnostic,
  printError,
  printValue,
  REQUIRE_SKIP_NOTE,
  usesRequire,
} from "./session.js";

const USAGE = `usage: arrival <command>

  arrival run <file.scm>    validate, then execute (require-root = the file's dir)
                            prints each non-define top-level form's value as s-expr
                            (subtle color on a TTY; plain when piped)
  arrival repl              interactive session (persistent defines, Ctrl-D exits)
  arrival check <file.scm> [more.scm …]
                            static diagnostics only — nothing is evaluated;
                            every file is checked, exit 1 if any has errors

options:
  --json                    (run) emit each form's value as JSON on stdout — one value
                            per line (NDJSON), for piping to jq and agent consumers.
                            Machine output is opt-in: default stdout stays s-expr.
  --outline                 (run) after the run, print a source-ordered outline of the
                            forms that executed to stderr — each with its state and its
                            invocation ×count (the dynamic multiplicity behind each form)
  --form <scope>            (run) drill into one form by its scopeId (head@line:col, from
                            --outline): its invocation aggregate, callers, sampled values
  --export                  (run) emit the run introspection as one versioned JSON object
                            on stdout (forms + counts + states + total invocations) — the
                            machine/agent contract; suppresses the normal value output
  --with <module>           arm a capability module (repeatable) — an npm package,
                            package subpath, or ./relative path exporting
                            EnvCapability instance(s)
  --config <file>           config file (default: ./arrival.config.ts|.json) —
                            { capabilities: [{ module, config? }…], config? }
  --banner quote|wordmark|off
                            (repl) splash at session start. Default: quote
                            (a shibboleth line, not a wordmark). ARRIVAL_BANNER
                            is the env equivalent.

environment:
  ARRIVAL_RUN_BUDGET_MS     wall-clock budget in ms   (default 300000)
  ARRIVAL_BANNER            quote (default) | wordmark | off
`;

async function readSource(file: string): Promise<string> {
  try {
    return await readFile(path.resolve(file), "utf8");
  } catch (error) {
    throw new Error(`arrival: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Color mode for the stderr inspection surfaces (outline / form detail): follows
 *  stderr's OWN isTTY (clig.dev per-stream rule) — a piped stderr stays uncolored. */
function stderrMode(): ColorMode {
  return streamColorMode(process.stderr.isTTY === true);
}

/** Color mode for check's stdout (diagnostics ARE the product). */
function stdoutMode(): ColorMode {
  return streamColorMode(process.stdout.isTTY === true);
}

/** Render the run outline to stderr (never stdout — stdout is the program's values, kept
 *  clean for `| jq`). The header's invocation total is the quiet "it did all that" beat —
 *  `(fib 10)` reports 796 invocations across 9 forms. `absFile` (the run file's absolute
 *  path) lets each location become a clickable OSC 8 hyperlink on a colored terminal. */
function emitOutline(trace: EvalTrace, absFile: string): void {
  const nodes = runView(trace);
  if (nodes.length === 0) return;
  process.stderr.write(`\n— run outline: ${nodes.length} forms, ${trace.invocationLog.length} invocations —\n`);
  for (const line of renderRunOutline(nodes, stderrMode(), absFile)) process.stderr.write(`${line}\n`);
}

/** Drill down into one form (its `scopeId`, from `--outline`) — its invocation aggregate,
 *  callers, and sampled values, to stderr. `absFile` threads through the same as above. */
function emitFormDetail(trace: EvalTrace, scope: string, absFile: string): void {
  process.stderr.write("\n");
  for (const line of renderFormDetail(formDetail(trace, scope), stderrMode(), absFile))
    process.stderr.write(`${line}\n`);
}

interface Inspect {
  readonly outline: boolean;
  readonly form?: string;
  /** `--export`: emit the run-introspection JSON contract to stdout, suppress values. */
  readonly export: boolean;
}

async function runFile(file: string, mode: OutputMode, inspect: Inspect, armed?: ArmedCapabilities): Promise<number> {
  const source = await readSource(file);
  // Resolved once — the absolute path the inspection surfaces hyperlink into (OSC 8), not
  // re-derived per emit.
  const absFile = path.resolve(file);
  // The interactive-run tap: `--outline` / `--form` / `--export` run under an `EvalTrace`
  // so the template↔invocation structure is captured. `undefined` tap ⇒ the byte-identical
  // untapped path.
  const trace = inspect.outline || inspect.form !== undefined || inspect.export ? new EvalTrace() : undefined;
  try {
    let values: unknown[];
    if (usesRequire(source)) {
      // The loader-armed ambient, jailed to the file's dir. Static validation still
      // can't see require-spilled bindings (see session.ts header) — runtime doors
      // remain the backstop, stated out loud.
      process.stderr.write(`${paint(REQUIRE_SKIP_NOTE, "gutter", stderrMode())}\n`);
      const { capabilities, config, runCtx, scope } = await loaderSession(
        path.dirname(path.resolve(file)),
        `arrival-file:${path.basename(file)}`,
        armed,
      );
      try {
        values = await exec(source, { capabilities, config, runCtx, scope, ...budgets(), tap: trace });
      } finally {
        await disposeRunContext(runCtx);
      }
    } else {
      // THE CUT: default base, whole-program diagnostics before the first form fires.
      // Armed capabilities join the assembly (their declared symbols enter the
      // validation vocabulary; `staticValidation: "on"` lowers them with
      // `degradation: "doors"`, so a config-listed capability missing an optional
      // enabling key reports the causal "provide X" diagnostic). Unarmed runs keep
      // the byte-identical realm-default path.
      values = await exec(source, {
        ...budgets(),
        staticValidation: "on",
        tap: trace,
        ...(armed === undefined ? {} : { capabilities: armed.capabilities, config: armed.config }),
      });
    }
    // `--export` mode: the introspection JSON IS the output (stdout stays a clean single
    // object for `| jq`), so it replaces value printing rather than joining it.
    if (inspect.export && trace !== undefined) {
      process.stdout.write(`${JSON.stringify(exportRun(trace))}\n`);
    } else {
      for (const v of values) printValue(v, mode);
      if (trace !== undefined) emitInspection(trace, inspect, absFile);
    }
    return 0;
  } catch (error) {
    printError(error);
    // Even on a fault, the partial trace is worth showing — it marks the failing form
    // `error`, which is often the whole point of asking for it. In export mode the partial
    // contract still goes to stdout (a consumer sees how far it got).
    if (inspect.export && trace !== undefined) process.stdout.write(`${JSON.stringify(exportRun(trace))}\n`);
    else if (trace !== undefined) emitInspection(trace, inspect, absFile);
    return 1;
  }
}

/** `--form` (drill into one form) takes precedence over `--outline` (the overview) when
 *  both are set — you asked for the specific thing. */
function emitInspection(trace: EvalTrace, inspect: Inspect, absFile: string): void {
  if (inspect.form !== undefined) emitFormDetail(trace, inspect.form, absFile);
  else if (inspect.outline) emitOutline(trace, absFile);
}

async function checkFile(file: string, armed?: ArmedCapabilities): Promise<number> {
  const source = await readSource(file);
  const mode = stdoutMode();
  if (usesRequire(source)) {
    // The pass would false-report every require-spilled name; it makes no claims here.
    console.log(`${paint(REQUIRE_SKIP_NOTE, "gutter", mode)}\n${file}: ${paint("skipped", "gutter", mode)}`);
    return 0;
  }
  const sentinel = new Error("arrival check: validation-only — evaluation refused by design");
  const controller = new AbortController();
  controller.abort(sentinel);
  try {
    await execState(source, {
      ...budgets(),
      staticValidation: "on",
      scope: LexicalScope.fresh("arrival-check"),
      signal: controller.signal,
      // Same arming as `run`'s validated path: declared symbols join the vocabulary,
      // doors degradation reports absent optional config as its causal diagnostic.
      ...(armed === undefined ? {} : { capabilities: armed.capabilities, config: armed.config }),
    });
    // Only an EMPTY program reaches here (no form ever touched the aborted signal).
    console.log(`${file}: ${paint("ok", "done", mode)}`);
    return 0;
  } catch (error) {
    if (error === sentinel) {
      console.log(`${file}: ${paint("ok", "done", mode)}`);
      return 0;
    }
    if (error instanceof StaticValidationError) {
      console.log(`${file}:`); // per-file attribution — `check` accepts many files
      for (const d of error.diagnostics) console.log(paintDiagnostic(d, mode));
      const errors = error.diagnostics.filter((d) => d.severity === "error").length;
      const summary = `${error.diagnostics.length} problem${error.diagnostics.length === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"})`;
      console.log(paint(summary, "gutter", mode));
      return errors > 0 ? 1 : 0;
    }
    printError(error); // reader/parse error — still a diagnostic outcome
    return 1;
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      with: { type: "string", multiple: true },
      config: { type: "string" },
      json: { type: "boolean" },
      outline: { type: "boolean" },
      form: { type: "string" },
      export: { type: "boolean" },
      banner: { type: "string" },
    },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [command, ...files] = positionals;
  switch (command) {
    case "run": {
      const [file, ...extra] = files;
      if (file === undefined) {
        process.stderr.write(`arrival run: missing <file.scm>\n${USAGE}`);
        return 2;
      }
      if (extra.length > 0) {
        // Never silently drop a positional: a green run that "looked like" it ran the whole
        // list is the false positive `check` used to ship. One program per invocation —
        // compose multi-file programs with (require …) instead.
        process.stderr.write(
          `arrival run: takes exactly ONE <file.scm> — also got ${extra.join(", ")}.\n` +
            `Run each program in its own invocation, or fold them into one entry file with (require …).\n`,
        );
        return 2;
      }
      const mode = resolveOutputMode({
        stdoutIsTTY: process.stdout.isTTY === true,
        env: process.env,
        json: values.json === true,
      });
      const [armed] = await Promise.all([
        armCapabilities(values.with ?? [], values.config, process.cwd()),
        mode.color ? attuneTerminal() : Promise.resolve(),
      ]);
      return runFile(
        file,
        mode,
        { outline: values.outline === true, form: values.form, export: values.export === true },
        armed,
      );
    }
    case "check": {
      if (files.length === 0) {
        process.stderr.write(`arrival check: missing <file.scm>\n${USAGE}`);
        return 2;
      }
      const [armed] = await Promise.all([
        armCapabilities(values.with ?? [], values.config, process.cwd()),
        attuneTerminal(),
      ]);
      // EVERY file is checked (no fail-fast — CI wants the complete list), exit is the worst
      // per-file outcome: any error-tier diagnostic anywhere ⇒ 1.
      let worst = 0;
      for (const file of files) worst = Math.max(worst, await checkFile(file, armed));
      return worst;
    }
    case "repl": {
      const armed = await armCapabilities(values.with ?? [], values.config, process.cwd());
      return repl(armed, { banner: values.banner });
    }
    case undefined:
      process.stderr.write(USAGE);
      return 2;
    default:
      process.stderr.write(`arrival: unknown command ${JSON.stringify(command)}\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    printError(error);
    process.exitCode = 1;
  },
);
