// `@inhuman.tools/arrival-modules` — `(require …)` as a sibling package.
//
// THIS BARREL is the require system: the EnvCapability, the Loader / fs seam,
// builtin dep-free resolvers (`.scm` / `.json` / `.ndjson` / `.txt`), and the
// editor type projection. File-type extension packs live on `./yaml`,
// `./toml`, `./handlebars`, and `./handlebars/runtime`; they are not
// re-exported here.

export { arrivalLoaderCapability } from "./loader-capability.js";
export { parseJsonc } from "./parse-jsonc.js";
export type { MaybePromise } from "./loader.js";
export {
  type Loader,
  type FsReadLike,
  makeFsLoader,
  type RequireResolver,
  loaderFromResolver,
  type ExtensionHandler,
  type ContentResolver,
  type RequireTypeProvider,
  type ResolverResult,
  contentsToText,
  valueToTsType,
  resolveRequireType,
  type SchemeForm,
  runResolverOf,
  normalizeToJson,
} from "./loader.js";
export {
  RunResolverUnreachableError,
  RequirePathError,
  RequireCycleError,
  RequireResolverError,
  ExtensionSuffixConflictError,
} from "./errors.js";
