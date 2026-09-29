# Arrival-Scheme — language surface (human inventory)

> **Agents** get only [`llm-agent-card.md`](./llm-agent-card.md) in the system prompt.
> **This file** is for humans: preferred vs runtime-loose recovery, absences, and pointers.

## The trick with “loose”

The runtime is **deliberately tolerant** of popular accents (suffix keys, bracket `let`,
`mapcar`, `#:name`, …). That is good _infrastructure_: models do not crash on training-set
muscle memory.

It is a bad _teaching_ surface. If the card documents both preferred and loose spellings,
models learn a second dialect and underuse the first. So:

| Layer              | Where it lives                       | Who learns it            |
| ------------------ | ------------------------------------ | ------------------------ |
| **Preferred**      | Agent card + this inventory          | Agents, deliberately     |
| **Loose recovery** | Reader / polyglot packs only         | Nobody — runtime absorbs |
| **Banned**         | Card “Do not use” + doors at runtime | Agents, as a wall        |

Edit the card when custdev shows underuse or oddities. Do not grow the card to enumerate
aliases the runtime already accepts.

Grammar: `grammar.md`. Coverage matrices: `reference/`. Custdev: `src/__custdev__/language-guide/`.

---

## Preferred (what the card teaches)

```scheme
(dict :k v)  {:k v}
(:k d)  (@ d k)  (get-in d path)  (assoc-in d path v)
(->> xs (filter p) (map f))
(take xs n)  (sort nums >)  (frequencies (map :k xs))
(str …)  (join sep xs)
```

Also available when needed (not card-core): `pipe`/`compose` · `group-by` · `partial` ·
`cut` · `zipmap` · vectors `[…]` / `#(…)`.

---

## Loose recovery (do not teach; runtime only)

Examples the reader/env absorb without documenting on the card:

- `{name: v}`, `#:name` → `:name`, JSON `{"a": 1}` (space after `:`)
- bracket `let` / `cond` bindings
- name aliases: `mapcar`, `nth`, `~>`, `true`/`false`, `nil?` (≡ `null?`), …
  **Traps that are not loose-success:** `{a:1}` (one symbol — need space after `:`).

---

## Absences

Sandbox by subtraction. Card ban list is enough for agents; messages name alternatives.

| Reach for                           | Do instead               |
| ----------------------------------- | ------------------------ |
| `set!` / mutators / `dict-set`      | rebind · `assoc-in`      |
| `call/cc` / `values`                | one structured return    |
| ports / `println` / `load` / `eval` | tools · return the value |
| hash tables                         | `dict`                   |

Detail: `reference/r7rs-coverage.md`, `reference/srfi-coverage.md`.

---

## Not this doc

R7RS manual · Sugarcoat (human view) · capability authoring · provenance theory · door _mechanism_.
