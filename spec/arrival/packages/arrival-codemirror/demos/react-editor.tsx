// The batteries-included React mount: <SchemeEditor> renders one canonical
// .scm through either lens. Sugarcoat derives on entering the lens, edits fold
// back to canonical Scheme losslessly; canonical stays the persisted truth.
//
// The IDE backend loads itself down the graceful ladder (SharedWorker →
// Worker → in-thread → plain editor). The worker rungs need a bundler that
// understands `new Worker(new URL(...), import.meta.url)`; under a plain dev
// server the ladder simply degrades to the in-thread rung.

import { useState } from "react";

import { SchemeEditor } from "@inhuman.tools/arrival-codemirror/react";

const INITIAL = `(define (greet name)
  (string-append "hello, " name))
`;

export function Demo(): React.ReactElement {
  const [scheme, setScheme] = useState(INITIAL);
  const [view, setView] = useState<"scheme" | "sugarcoat">("scheme");
  const [parseError, setParseError] = useState<string | null>(null);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div>
        <button onClick={() => setView(view === "scheme" ? "sugarcoat" : "scheme")}>lens: {view}</button>
        {parseError !== null && <span> ⚠ {parseError}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <SchemeEditor
          value={scheme}
          onChange={setScheme}
          view={view}
          onSugarcoatError={setParseError}
          structuralEditing // paredit on the Scheme lens (off by default)
        />
      </div>
    </div>
  );
}
