/**
 * The sugarcoat lens (D3) — OUTPUT only. Cheap because the serializer
 * already produces parse-safe text: a rendered value (or an echoed source slice) is
 * always a re-parseable scheme string, so flipping it to sugarcoat is just
 * `schemeToSugarcoat(text)` — arrival-awesome-repl.md §8's documented composition
 * ("run the budgeted serializer first … parse its output with the sugarcoat package's
 * own parseSexprs, print through the lens") IS this function, not a separate
 * value→Node quotation step. Reusing the printer directly means zero new budget/
 * truncation logic.
 *
 * INPUT stays Scheme — and §8's "In — already true: the reader accepts both
 * surfaces" is WRONG for the core reader: `parse("{n * n}")` rejects curly-infix with
 * a teaching door ("this reader has no curly-infix mode … lives in arrival-sugarcoat,
 * not core arrival"). Sugarcoat-surface INPUT would need a lowering pass
 * (`sugarcoatToScheme`) ahead of `parse`, deliberately not wired here — only the
 * ECHOED source + rendered values flip surfaces via `,lens`.
 *
 * `,lens` (repl.ts) flips `Lens` for the whole session; every block re-renders through
 * whichever lens is active — same stored text, two views, the round-trip law
 * (arrival-sugarcoat's own tested invariant) is what makes that honest.
 */
import { schemeToSugarcoat } from "@inhuman.tools/arrival-sugarcoat";

export type Lens = "scheme" | "sugarcoat";

/** Render `text` (a valid, already-parseable scheme source slice or serialized value)
 *  through `lens`. `sugarcoat` falls back to the original text on a parse failure —
 *  e.g. a serializer truncation marker or attachment tag the sugarcoat reader doesn't
 *  model — so a lens flip never loses content, only its extra formatting. */
export function toLens(text: string, lens: Lens): string {
  if (lens === "scheme" || text.trim() === "") return text;
  try {
    return schemeToSugarcoat(text);
  } catch {
    return text;
  }
}
