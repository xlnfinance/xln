# @inhuman.tools/arrival-modules

`(require …)` as an `EnvCapability` — path jail, cycle / resolver doors, and builtin `.scm` / `.json` / `.ndjson` / `.txt` resolvers.

This package is a sibling of `@inhuman.tools/arrival` so parsers stay out of the interpreter. Root `arrivalLoaderCapability` (or an extension pack that depends on it) and pass `fs` or a pre-built `loader` in the shared config bag.

## Main export (`.`)

- `arrivalLoaderCapability` — `(require …)` / `(require/extension …)` / `(require/register-extension …)`. Config: `fs` (capability derives `makeFsLoader` itself) or `loader` (wins, for a custom resolver table), plus `dirname`. Missing both doors.
- `makeFsLoader({ readFile })` — generic-fs seam; builtin resolvers on `.scm` / `.json` / `.ndjson` / `.txt`.
- Errors: `RequirePathError` (NUL / `..` jail escape), `RequireCycleError`, `RequireResolverError` (no handler / no armed extension), `ExtensionSuffixConflictError`, `RunResolverUnreachableError`.

Yaml, toml, and handlebars are **not** on this barrel.

## Footgun: yaml / toml / handlebars are subpath exports with optional peers

`(require "x.yaml")` does not work until you root `./yaml` **and** install `yaml`. Same for toml (`smol-toml`) and handlebars (`handlebars`).

| Subpath                | Capability                                                         | Optional peer |
| ---------------------- | ------------------------------------------------------------------ | ------------- |
| `./yaml`               | `arrivalYamlCapability`                                            | `yaml`        |
| `./toml`               | `arrivalTomlCapability`                                            | `smol-toml`   |
| `./handlebars`         | `arrivalHandlebarsCapability`                                      | `handlebars`  |
| `./handlebars/runtime` | pure JS (`templateHandlebars`, `handlebarsParse`, `handlebarsRun`) | —             |

`./handlebars/runtime` is the surface mercury emit imports. It is not re-exported from `.`.

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "@inhuman.tools/arrival";
import { makeFsLoader } from "@inhuman.tools/arrival-modules";
import { arrivalYamlCapability } from "@inhuman.tools/arrival-modules/yaml";

const root = "/project";
await exec(`(require "x.yaml")`, {
  capabilities: [arrivalYamlCapability], // deps include arrivalLoaderCapability
  config: {
    loader: makeFsLoader({ readFile: (p) => fs.readFile(path.resolve(root, p)) }),
    dirname: "",
  },
});
```

## License

[MIT](./LICENSE.md).
