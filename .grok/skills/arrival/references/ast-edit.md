# Symbol edits

A slot on a named declaration, as a value the program can refuse. `ast-edit/preview` writes nothing. `ast-edit/apply` writes that text inside the repo. The batch applies entirely or not at all. Bytes outside the slot stay as they were.

## Call

```scheme
(define next
  (ast-edit/preview
    :path "pure/entity/paybook/paybook.ts"
    :operations (list
      (dict :action "set_return_type"
            :target "arrow_function"
            :name "intentOf"
            :value "Intent | undefined"))))
```

Read `(:preview next)`. The check before apply is `jev/gate`, in `jev-gate.md`. Apply only when that text is the edit you would have typed, and `produced.md` accepts it. A list of pairs is the same operation as a dict.

## Actions

| action | target | name | value |
|---|---|---|---|
| `set_return_type` | `function`, `method`, `arrow_function` | the declaration | the type |
| `add_parameter` | the same | the declaration | one parameter, `cache: boolean` |
| `remove_parameter` | the same | the declaration | the parameter's name |
| `add_named_import` | | the imported name | the module specifier |

A method may be `ClassName.member`. A short name is enough when only one declaration has it. An arrow written `x => x` is refused. Two operations that insert at the same point are refused. A name that is already imported changes nothing.

## Not borrowed

No `set_body`, `replace`, `replace_in_body`, or `newCode`. A body is not a slot. No `rename`: a rename that cannot see every use is a broken name. No class, async, decorator, or modifier action.
