---
name: arrival
description: >
  Write one Arrival Scheme program when the output of a bound tool is the
  input of another. Use when combining ast-grep, the spec checker, rewrite,
  ast-edit, and jev/gate, or when a search result would be pasted into a
  second tool call. Use when the user runs /arrival.
---

# Arrival programs

The rule for when is the Tools section of `AGENTS.md`. This file is how.

Call `arrival__scheme-repl-with-all-mcp-tools`. Put the program in `repl-input-scheme-program`, one string or an array of statements, run together. Call a bound tool with keyword arguments. A text result is `(:result value)`. A JSON object arrives as that dict, and `(:key obj)` reads a field. Bind every result and reduce it in the program. The display may omit text. The bound value is whole.

`(define ...)` stays for later calls in this process. A rebuild of the tool list drops those definitions. Call only a symbol this process's tool description lists. A server added to `spec/manifold.mcp.json` is bound when the process starts. Do not restart it unless the user asks.

A search that ends at the matches is the ast-grep CLI, as `AGENTS.md` says. A TypeScript binding is the language server, not a symbol in this program. A host tool that is not an upstream in `spec/manifold.mcp.json` is not a function here.

## Examples

Read `.grok/skills/arrival/references/examples.md` when you are writing the program. Open the heading you need.

- Two results, one dict
- A dump in the same program
- Several nodes
- Source order is one rewriter
- Read the replacement, then refuse it
- The checker, and one planted break

## Which symbol

- `ast-grep/find_code` takes one pattern that is one AST node. `project_folder` is an absolute path.
- `ast-grep/find_code_by_rule` takes the YAML and scans the tree. `inside` and `has` need `stopBy: end`.
- `ast-grep/dump_syntax_tree` shows the nodes. `format` is `cst`, `ast`, or `pattern`. When a pattern is rejected as several nodes, dump the tree, then match with `pattern.context` and `selector`.
- `ast-grep/test_match_code_rule` tests a snippet. Zero matches is an error. It does not scan the tree.
- `spec/arrival_run` runs a file under `spec/` or a snippet. `spec/arrival_check` and `spec/arrival_guide` are the other two.
- `rewrite/preview` takes `yaml` and exactly one of `path` or `code`. Read `preview`.
- `rewrite/apply` takes `yaml` and `path`, and writes that text inside the repo.
- `ast-edit/preview` and `ast-edit/apply` change a slot of a named declaration. The steps are `.grok/skills/arrival/references/ast-edit.md`.
- `jev/gate` reads that preview and returns allow, doubt, or refuse. The program is `.grok/skills/arrival/references/jev-gate.md`.
- A TypeScript binding in `pure/` is the language server. `lsp/references` is in the manifold and is not that search. The call, when a program must hold the locations, is `.grok/skills/arrival/references/lsp.md`.
- A hit from `node spec/map/name.mjs` is a file and a line. A `configs/` or `bugs/` define replaces the page binding for that run. A Solidity identifier hit is not a binding. Neither is an argument to `ast-edit/apply`.

## Symbol edits

Read `.grok/skills/arrival/references/ast-edit.md` when the change is a type, a parameter, or a named import.

- Call
- Actions
- Not borrowed

## Produced code

Read `.grok/skills/arrival/references/produced.md` when a replacement would be applied, or when you write the edit by hand.

- What wins
- The match
- The function
- Values

## TypeScript references

Read `.grok/skills/arrival/references/lsp.md` only when a program must hold the locations. The search is the language server.

- Call
- What it is not

## The check

Read `.grok/skills/arrival/references/jev-gate.md` when a preview would be applied.

- Call
- Verdicts
- What it will not catch
- Checked

## The replacement

Matches that must stay in source order are one rewriter and one `fix`, so the scan returns one replacement. Read it. Do not apply a replacement that rebinds the name the pattern matched, or that flattens a block onto one line. Write that edit by hand.

`apply` refuses an overlap and a byte span that is no longer the matched text. A path outside the repo is refused, as `AGENTS.md` says.
