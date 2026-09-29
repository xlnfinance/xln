// resources-surface — the `/resources` subpath's CURATED external face: the port MODEL a
// capability author declares against (`Resource`/`AcquireCtx`/`port`). `Ref`/`ResourceCell`/
// `windDownAll` (resources.ts) are RUNTIME MACHINERY only the bind loop consumes — never part
// of the authoring contract, so they stay off this subpath (still reachable by relative import
// from `./resources.js`).
export type { Resource, AcquireCtx } from "../resources.js";
export { port } from "../resources.js";
