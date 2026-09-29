import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { schemeToSugarcoat, sugarcoatToScheme } from "@inhuman.tools/arrival-sugarcoat";
import { editorFill, ideaSearch, theme } from "@here.build/editor-theme";
import CodeMirror from "@uiw/react-codemirror";

import {
  paramHintsExtension,
  schemeIde,
  schemeStructural,
  schemeSugarcoat,
  sugarcoatIdeBackend,
  type SchemeStructuralOptions,
} from "../index.js";
import { setSchemeIdeOpenPath, useSchemeIde } from "./use-scheme-ide.js";

// Stable identity — @uiw/react-codemirror reconfigures ALL extensions whenever
// `basicSetup` or `onChange` identity changes. A fresh object/callback per
// render restarts StreamLanguage parse from scratch; the first parse slice
// covers the head (~50–70 lines), and the rest flashes unhighlighted until the
// parse worker catches up. Module-level constants keep that off the keystroke path.
// searchKeymap: false — ideaSearch() owns Mod-f / Mod-Alt-f (stock panel is ugly).
const BASIC_SETUP = {
  lineNumbers: true,
  highlightActiveLine: false,
  foldGutter: true,
  searchKeymap: false,
} as const;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type View = "scheme" | "sugarcoat";

export interface SchemeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  /**
   * Project-relative path of this buffer (e.g. `inhuman-custdev/best-tagline.scm`).
   * When set, relative `(require "config.scm")` resolves against this file's
   * directory via the scheme IDE files table.
   */
  path?: string;
  /** Which lens to show. CONTROLLED by the studio's unified
   *  `[scheme][sugarcoat][graph]` switch (the graph mode is handled above this — when
   *  graph is shown, FileEditor isn't mounted). */
  view?: View;
  /** Reports the sugarcoat buffer's parse state up so the studio can show the
   *  "⚠ unsaved" marker next to the switch (null = parses / not in sugarcoat). */
  onSugarcoatError?: (err: string | null) => void;
  /** Cross-file goto-def: Cmd/Ctrl-click on a `require`d name lands here —
   *  `(path, span-in-that-file)`. The studio wires its file switcher. */
  onNavigate?: (path: string, span: { start: number; length: number }) => void;
  /** Host extensions mounted on the Scheme lens only (the saas shell's run
   *  plumbing: cost-bar decorations, focus/blur run triggers, cursor tracking).
   *  Scheme-only because they anchor to Scheme source offsets — the sugarcoat
   *  lens moves them. */
  schemeExtensions?: Extension[];
  /** The Scheme lens's EditorView, for hosts that dispatch into it (cost-bar
   *  decoration refresh). Called with the view on mount, null on unmount. */
  onCreateEditor?: (view: EditorView | null) => void;
  /** Paredit-style structural editing on the Scheme lens (expand/contract
   *  selection, slurp/barf, splice, kill-sexp, strict delete protection,
   *  structural indent) — OFF by default. It reassigns several muscle-memory
   *  chords (Alt-↑/↓ shadows Move Line, Mod-Shift-K shadows Delete Line) and
   *  refuses any Backspace/Delete that would unbalance the buffer (Alt-Backspace
   *  / mac Ctrl-Backspace force-deletes past it). Pass `true` for the defaults,
   *  or an options object to disable individual pieces. */
  structuralEditing?: boolean | SchemeStructuralOptions;
}

/**
 * Scheme + sugarcoat lenses over canonical `.scm`.
 *
 * Controlled `view` prop. Sugarcoat = readable surface; canonical scheme is
 * always the persisted truth.
 *
 * Lens contract (one-directional, stable bifunctor):
 * - Enter sugarcoat: derive once via schemeToSugarcoat (user formatting preserved).
 * - While in sugarcoat: sugarcoat buffer is authoritative; edits forward via
 *   sugarcoatToScheme (per-form splice + canonical reprint fallback).
 * - Never reflow sugarcoat from Scheme (would clobber formatting).
 * - Unparseable sugarcoat: hold last good Scheme, surface error.
 * - External value change (not our echo) re-seeds.
 *
 * Structural/parens hints only on Scheme. IDE uses sugarcoatIdeBackend on sugarcoat.
 */
export function SchemeEditor({
  value,
  onChange,
  readOnly,
  path,
  view = "scheme",
  onSugarcoatError,
  onNavigate,
  schemeExtensions,
  onCreateEditor,
  structuralEditing = false,
}: SchemeEditorProps): React.ReactElement {
  // Relative require resolution joins against this buffer's directory.
  useEffect(() => {
    if (path === undefined) return;
    setSchemeIdeOpenPath(path);
    return () => {
      // Only clear if we still own the slot (another editor may have taken over).
      setSchemeIdeOpenPath(null);
    };
  }, [path]);

  // The Scheme buffer is canonical truth (mirrors File.body).
  const [text, setText] = useState(value);
  // The sugarcoat buffer: the truth WHILE the sugarcoat view is open. Seeded from the
  // Scheme on entering sugarcoat and thereafter one-directional (sugarcoat → Scheme).
  const [sugarcoat, setSugarcoat] = useState("");
  const [sugarcoatErr, setSugarcoatErr] = useState<string | null>(null);

  // Live prop refs so stable callbacks never reconfigure CM on parent re-render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSugarcoatErrorRef = useRef(onSugarcoatError);
  onSugarcoatErrorRef.current = onSugarcoatError;
  const onCreateEditorRef = useRef(onCreateEditor);
  onCreateEditorRef.current = onCreateEditor;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const textRef = useRef(text);
  textRef.current = text;

  // Seed sugarcoat only on entering sugarcoat (view dep). A text change while sugarcoat
  // is active came from sugarcoat itself — reseeding would destroy formatting.
  useEffect(() => {
    if (view !== "sugarcoat") return;
    try {
      setSugarcoat(schemeToSugarcoat(textRef.current));
      setSugarcoatErr(null);
    } catch (error) {
      setSugarcoat(textRef.current); // un-renderable scheme: fall back to raw, still editable
      setSugarcoatErr(errMsg(error));
    }
  }, [view]);

  // External file change (not our optimistic echo) re-seeds text.
  // value === text for our own edits (studio is optimistic).
  useEffect(() => {
    if (value !== textRef.current) setText(value);
  }, [value]);

  // Surface the parse state to the studio's switch (only meaningful in sugarcoat).
  useEffect(() => {
    onSugarcoatErrorRef.current?.(view === "sugarcoat" ? sugarcoatErr : null);
  }, [sugarcoatErr, view]);

  // The Scheme view handle goes null whenever the Scheme editor unmounts —
  // switching to the sugarcoat lens or unmounting entirely — so a host never
  // dispatches into a destroyed view.
  useEffect(() => {
    if (view === "sugarcoat") onCreateEditorRef.current?.(null);
  }, [view]);
  useEffect(() => () => onCreateEditorRef.current?.(null), []);

  // Stable identity for @uiw — see BASIC_SETUP comment. Parent onChange is
  // reached through a ref so host re-renders never reconfigure the editor.
  const onSchemeChange = useCallback((v: string): void => {
    setText(v);
    onChangeRef.current?.(v);
  }, []);

  const onSugarcoatChange = useCallback((v: string): void => {
    setSugarcoat(v); // never reflow user's sugarcoat formatting
    try {
      // Forward: unchanged top forms keep exact bytes; edited ones reprint.
      const scheme = sugarcoatToScheme(v, textRef.current);
      setText(scheme);
      onChangeRef.current?.(scheme);
      setSugarcoatErr(null);
    } catch (error) {
      setSugarcoatErr(errMsg(error)); // hold last good Scheme
    }
  }, []);

  // Stable mount callback — inline `(v) => onCreateEditor?.(v)` is a new
  // function every render (not in uiw's reconfigure deps, but still wasteful
  // and easy to trip if uiw adds it later).
  const handleCreateEditor = useCallback((v: EditorView) => {
    onCreateEditorRef.current?.(v);
  }, []);

  // The IDE backend (type-checked diagnostics / hover / completion / goto-def)
  // loads lazily and lands when ready; until then the editor is plain. The
  // backend answers in Scheme coordinates; the sugarcoat lens mounts the
  // SAME backend through `sugarcoatIdeBackend` (the sugarcoat↔Scheme span aligner).
  const ide = useSchemeIde(true);

  // Stable openFile for schemeIde so schemeExt/sugarcoatExt don't rebuild on
  // every parent identity of onNavigate.
  const openFile = useCallback((path: string, span: { start: number; length: number }) => {
    onNavigateRef.current?.(path, span);
  }, []);
  const hasNavigate = onNavigate !== undefined;

  const schemeExt = useMemo<Extension[]>(
    // Parameter inlay hints + structural (paredit) editing are .scm-only, and
    // Scheme-lens-only — the sugarcoat lens's indentation is semantic, so
    // structural ops there would be wrong, not just unmapped.
    () => [
      schemeSugarcoat(),
      theme,
      editorFill,
      ideaSearch(),
      ...(schemeExtensions ?? []),
      paramHintsExtension("scheme"),
      ...(structuralEditing === false
        ? []
        : [schemeStructural(structuralEditing === true ? undefined : structuralEditing)]),
      ...(ide === null ? [] : [schemeIde(ide, hasNavigate ? { openFile } : {})]),
    ],
    [ide, openFile, hasNavigate, structuralEditing, schemeExtensions],
  );
  // The sugarcoat lens always shows a .scm, so it always gets the (sugarcoat) hints —
  // plus the full IDE through the sugarcoat↔Scheme aligner. (Structural ops stay
  // Scheme-only — sugarcoat indentation is semantic.)
  const sugarcoatExt = useMemo<Extension[]>(
    () => [
      schemeSugarcoat(),
      theme,
      editorFill,
      ideaSearch(),
      paramHintsExtension("sugarcoat"),
      ...(ide === null ? [] : [schemeIde(sugarcoatIdeBackend(ide), hasNavigate ? { openFile } : {})]),
    ],
    [ide, openFile, hasNavigate],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {view === "sugarcoat" ? (
          <CodeMirror
            key="sugarcoat"
            value={sugarcoat}
            extensions={sugarcoatExt}
            editable={!readOnly}
            onChange={onSugarcoatChange}
            theme="none"
            height="100%"
            style={{ height: "100%" }}
            basicSetup={BASIC_SETUP}
          />
        ) : (
          <CodeMirror
            key="scheme"
            value={text}
            extensions={schemeExt}
            editable={!readOnly}
            onChange={onSchemeChange}
            onCreateEditor={handleCreateEditor}
            theme="none"
            height="100%"
            style={{ height: "100%" }}
            basicSetup={BASIC_SETUP}
          />
        )}
      </div>
    </div>
  );
}
