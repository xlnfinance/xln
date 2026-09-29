// One program, two faces — the SAME backend on both.
//
// The left editor shows canonical Scheme; the right shows the Sugarcoat
// rendering of the same program (derived once via schemeToSugarcoat). The
// Scheme editor mounts the IDE directly; the Sugarcoat editor mounts the SAME
// backend through sugarcoatIdeBackend, the sugarcoat↔Scheme span aligner —
// hover/lint/completion answers travel sugarcoat → Scheme → TypeScript.

import { EditorView, lineNumbers } from "@codemirror/view";
import { schemeToSugarcoat } from "@inhuman.tools/arrival-sugarcoat";
import { createBrowserSchemeLanguageService } from "@inhuman.tools/arrival-lsp/browser";

import {
  paramHintsExtension,
  schemeIde,
  schemeSugarcoat,
  sugarcoatIdeBackend,
} from "@inhuman.tools/arrival-codemirror";

const canonical = `(define (loud-names names)
  (map string-upcase names))

(loud-names (list "ada" "grace"))
`;

const backend = createBrowserSchemeLanguageService();

export const schemeView = new EditorView({
  parent: document.querySelector("#scheme")!,
  doc: canonical,
  extensions: [lineNumbers(), schemeSugarcoat(), paramHintsExtension("scheme"), schemeIde(backend)],
});

export const sugarcoatView = new EditorView({
  parent: document.querySelector("#sugarcoat")!,
  doc: schemeToSugarcoat(canonical),
  extensions: [
    lineNumbers(),
    schemeSugarcoat(), // one language mode covers both faces
    paramHintsExtension("sugarcoat"),
    schemeIde(sugarcoatIdeBackend(backend)), // same seam in, same seam out
  ],
});
