// Vanilla CodeMirror 6 + the full arrival IDE — no framework, no worker.
//
// The in-process browser language service (`tsc` compiled for the browser,
// bundled prelude) satisfies the SchemeIdeBackend seam directly. `(greet 42)`
// below gets a real type error, lifted back to its .scm span.

import { closeBrackets } from "@codemirror/autocomplete";
import { EditorView, lineNumbers } from "@codemirror/view";
import { createBrowserSchemeLanguageService } from "@inhuman.tools/arrival-lsp/browser";

import { paramHintsExtension, schemeIde, schemeStructural, schemeSugarcoat } from "@inhuman.tools/arrival-codemirror";

const doc = `(define (greet name)
  (string-append "hello, " name))

(greet 42)
`;

export const view = new EditorView({
  parent: document.querySelector("#editor")!,
  doc,
  extensions: [
    lineNumbers(),
    closeBrackets(),
    schemeSugarcoat(), // language + highlighting (tags only — bring a theme)
    schemeStructural(), // paredit: slurp/barf/splice/kill + strict delete + indent
    paramHintsExtension("scheme"), // inlay parameter hints
    schemeIde(createBrowserSchemeLanguageService()), // lint/hover/completion/goto/semantic
  ],
});
