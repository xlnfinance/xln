import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import { SchemeEditor } from "./SchemeEditor.js";

// Live IDE surface — the unit suite pins pure decision functions; view plumbing
// (ghost debounce/widget/Tab, lens switch, structural edit) is exercised here.

const INITIAL = `(define (greet name)
  (string-append "hello, " name))

(greet 42)
`;

function LiveEditor() {
  const [scheme, setScheme] = useState(INITIAL);
  const [view, setView] = useState<"scheme" | "sugarcoat">("scheme");
  const [parseError, setParseError] = useState<string | null>(null);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#1a1a1a", color: "#ddd" }}>
      <div style={{ padding: "0.5rem 0.75rem", display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <button type="button" onClick={() => setView(view === "scheme" ? "sugarcoat" : "scheme")}>
          lens: {view}
        </button>
        {parseError !== null && <span>⚠ {parseError}</span>}
        <span style={{ opacity: 0.6, fontSize: 12 }}>
          Hover <code>greet</code> · Ctrl-Space inside the call · try structural chords
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <SchemeEditor
          value={scheme}
          onChange={setScheme}
          view={view}
          onSugarcoatError={setParseError}
          structuralEditing
        />
      </div>
    </div>
  );
}

const meta = {
  title: "SchemeEditor",
  component: SchemeEditor,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SchemeEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const IdeDemo: Story = {
  // `render` supplies its own state-managing `LiveEditor`, so args are unused — but the
  // component's required `value` prop makes storybook demand an `args` bag; give it one.
  args: { value: INITIAL },
  render: () => <LiveEditor />,
};
