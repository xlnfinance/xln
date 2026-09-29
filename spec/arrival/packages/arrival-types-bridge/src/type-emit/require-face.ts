/**
 * Types-only require faces — per-file `export default` modules for the type lens.
 *
 * Product compile (full runtime TS) lives in `build/hbs-module.ts` /
 * `build/pretreat-module.ts`: pretreat → `compileScmModule`.
 *
 * Types compile (this file) is the simplified twin: `.hbs` pretreat → `emitTypes`;
 * every other path is a typed default-export stub from the host `reqType`.
 * Domain filetypes (`.prompt`) synthesize that string outside mercury.
 */
import { hbsContentsToSchemeSource } from "@inhuman.tools/arrival-modules/handlebars";

import { emitTypes, type EmitTypesOptions } from "./emit.js";

const HBS_HOST = new Set(["template/handlebars", "cons"]);

/** Data face (json/yaml/…): typed default export from the registry type string. */
export function emitDataRequireFace(reqType: string): string {
  return `const __default = null as any as ${reqType};\nexport default __default;\n`;
}

/**
 * Typed stub default export. Fallback when pretreat→emitTypes is not used
 * (data files, host-synthesized callable faces).
 */
export function emitTypedRequireFace(reqType: string): string {
  return `const __default: ${reqType} = null as any as ${reqType};\nexport default __default;\n`;
}

/**
 * `.hbs` types face: pretreat (`hbsContentsToSchemeSource`) then `emitTypes`,
 * re-export as default — same pretreat as product `compileHbsFile`, no scm-module.
 */
export function emitHbsRequireFace(content: string, opts?: EmitTypesOptions): string {
  const scheme = hbsContentsToSchemeSource(content);
  const hostMembers = new Set([...(opts?.hostMembers ?? []), ...HBS_HOST]);
  const { ts } = emitTypes(`(define __default ${scheme})`, { ...opts, hostMembers });
  return ts.replace(/\n?export \{\};\n?$/, "\nexport default __default;\n");
}

/**
 * Dispatch: build the virtual-module TS for one require path.
 * @param content file bytes when available (enables hbs pretreat)
 * @param reqType host-synthesized type string (data files; domain callables)
 */
export function emitRequireFaceModule(
  path: string,
  content: string | null,
  reqType: string,
  opts?: EmitTypesOptions,
): string {
  if (path.endsWith(".hbs") && content !== null) {
    return emitHbsRequireFace(content, opts);
  }
  return emitDataRequireFace(reqType);
}
