# TypeScript references

The search is the language server. `lsp/references` and `lsp/definition` are that question inside a program, for when the locations are the input of a later step. They write nothing. A location is not an operation for `ast-edit/apply`. The running Arrival process does not have the symbols until it is restarted.

## Call

```scheme
(define uses
  (lsp/references :path "pure/entity/fixtures.ts" :line 41 :column 14))
```

`(:name uses)` is the identifier under the column. `(:locations uses)` is a list of dicts with `path`, `line`, `column`, and `definition`. Line and column are 1-based. On that line, column 14 is the `o` of `open`.

`lsp/definition` takes the same arguments and returns where the identifier is bound.

## What it is not

Scheme stays `node spec/map/name.mjs`. Solidity stays an ast-grep identifier query. A comment is not a symbol. A file outside `pure/tsconfig.json`, or outside the repo, is refused. The file list is the config when the process starts. Bytes are read at the query. The check is `node --test spec/mcp/lsp.test.mjs`: the fixture `open` and the link `open` do not share a location.
