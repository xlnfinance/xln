// ls-protocol — barrel for the worker protocol's two halves.
//
// Main-thread consumers should import `./ls-client` (light — no typescript,
// no bundles); worker entries import `./ls-server` (or just `./worker`).
// This barrel exists for in-process use and tests, where both sides meet
// over a MessageChannel.

export {
  connectSchemeLs,
  LS_METHODS,
  type AsyncSchemeLanguageService,
  type LsPort,
  type SchemeLsWorkerOptions,
} from "./ls-client.js";
export { peekSharedService, serveSchemeLs } from "./ls-server.js";
