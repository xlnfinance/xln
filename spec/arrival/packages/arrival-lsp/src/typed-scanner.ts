// typed-scanner.ts — the Σ∩T bridge: wrap a structural+Σ OracleScanner so its `validSymbols()`
// is narrowed by Layer T (getTypeValidCandidates). The sampler's mask machinery
// (isCandidateLive / passesSigma) is UNCHANGED — it just receives a smaller, type-valid symbol
// set, so a candidate whose value/return can't fill the current argument slot is masked out.
//
// WHY HERE (not in arrival-sampler): the sampler is browser-targeted and must stay light; the type
// lens pulls in the TypeScript compiler (node-only). So this adapter — which depends on BOTH — lives
// on the lens side, and a node-side runner composes `narrowByType(sigmaScanner, ls)` to get a
// type-aware scanner. In the browser, you use the bare Σ scanner; under node you wrap it.
//
// PERF: T is a TS round-trip — far too slow to run per vocab candidate. But the type-valid set is a
// property of the SLOT (which call, which argument), identical for every candidate extending the
// same cursor. So it is memoized by the slot prefix (the accepted text minus the atom being typed):
// one `getTypeValidCandidates` per decode step, reused across all candidates that step.

/** The structural OracleScanner surface this adapter consumes/produces — a subset of arrival's
 *  (and sift's) OracleScanner, kept structural so any real scanner satisfies it. */
export interface ScannerState {
  readonly midToken: boolean;
  readonly position: "top" | "operator" | "argument";
  readonly formKind: "top" | "application" | "lambda-list" | "quote" | "lazy-arm";
  readonly closeable: boolean;
  validSymbols(): ReadonlySet<string> | null;
  /** The argument slot's TS type is an array/list type — the precise list-structure gate's source.
   *  Stamped SYNCHRONOUSLY here so it is present the instant the (sync) mask reads it at the value-opener. */
  readonly slotIsArray?: boolean | null;
  /** The argument slot admits a bare word as a STRING — the scalar-string Σ exemption's source. Stamped
   *  SYNCHRONOUSLY here so it is present the instant the (sync) mask's Σ gate reads it. See
   *  `OracleState.slotIsStringy` in arrival-sampler. */
  readonly slotIsStringy?: boolean | null;
  /** The ELEMENT type at an array-element cursor is a free-form string/any (CUT A) — the array-element
   *  force-quote gate's source. Stamped SYNCHRONOUSLY here so it is present the instant the sync mask reads
   *  it at the element value-opener. See `OracleState.elementIsStringy` in arrival-sampler. */
  readonly elementIsStringy?: boolean | null;
  /** The ELEMENT type at an array-element cursor is a closed string-literal union — its MEMBERS (CUT A) — the
   *  element enum-narrow's source. See `OracleState.elementEnum` in arrival-sampler. */
  readonly elementEnum?: readonly string[] | null;
}
export interface Scanner {
  analyze(prefix: string): ScannerState;
  feasible(prefix: string): boolean;
}

/** The two methods of the language service this adapter needs — the value narrowing (Σ∩T) and the
 *  structure verdict (the list-structure gate). Both SYNC: the LS is sync, so the scanner is too. */
export interface TypeLens {
  getTypeValidCandidates(scheme: string, schemeOffset: number, candidates: readonly string[]): string[];
  getSlotIsArray(scheme: string, schemeOffset: number): boolean | null;
  getSlotAcceptsBareWord(scheme: string, schemeOffset: number): boolean | null;
  getSlotElementType(scheme: string, schemeOffset: number): { isStringy: boolean | null; enum: string[] | null };
}

const ATOM = /[^\s()[\]{}"';]/; // an atom character (arrival's lexer: not ws / bracket / string / quote / comment)

/** The trailing run of atom characters at the end of `s` (the partial symbol being typed), or "". */
function trailingAtom(s: string): string {
  let i = s.length;
  while (i > 0 && ATOM.test(s[i - 1]!)) i--;
  return s.slice(i);
}

/**
 * Wrap `base` so `analyze(s).validSymbols()` is intersected with the Layer-T type-valid set at the
 * cursor's argument slot. Narrowing applies ONLY at a Σ-constrained APPLICATION ARGUMENT slot —
 * operators and non-application contexts pass through unchanged (Σ owns operators; T never adds a
 * wrong restriction). Conservative by construction: `getTypeValidCandidates` keeps any candidate it
 * can't prove ill-typed, so the narrowed set is never smaller than the truly-valid set.
 */
export function narrowByType(base: Scanner, lens: TypeLens): Scanner {
  // slotPrefix → the T-valid subset of that slot's Σ (as a Set). Memoized across the decode step.
  const cache = new Map<string, ReadonlySet<string>>();
  // slotPrefix → the slot's array-ness (the structure-gate source). Memoized per slot, like `cache`.
  const arrayCache = new Map<string, boolean | null>();
  // slotPrefix → the slot's stringy-ness (the scalar-string Σ-exemption source). Memoized per slot.
  const stringyCache = new Map<string, boolean | null>();
  // slotPrefix → the array-ELEMENT verdict (CUT A: force-quote / enum-narrow source). Memoized per slot.
  const elementCache = new Map<string, { isStringy: boolean | null; enum: string[] | null }>();
  return {
    feasible: (prefix) => base.feasible(prefix),
    analyze(s) {
      const st = base.analyze(s);
      // The three SCALAR axes act only inside an application ARGUMENT slot (Σ owns operators; T never adds a
      // wrong restriction). The ELEMENT axis (CUT A) ALSO acts inside a QUOTE form — the `'(…)` array surface.
      const inAppArg = st.formKind === "application" && st.position === "argument";
      const inQuote = st.formKind === "quote";
      if (!inAppArg && !inQuote) return st;
      // The slot is fixed for the whole atom being typed → key by the prefix up to the atom start. At a
      // value BOUNDARY (no atom yet) the trailing atom is "" ⇒ slotPrefix = s, the slot about to open.
      const slotPrefix = s.slice(0, s.length - trailingAtom(s).length);

      // ELEMENT (CUT A) — stamp the array-element verdict SYNCHRONOUSLY, in BOTH surfaces, at the boundary
      // AND mid-atom (the force-quote masks the value-opener; the enum-narrow reads while a bare word is
      // typed). The whole point of the sync scanner: present the instant the sync mask reads it.
      let element = elementCache.get(slotPrefix);
      if (element === undefined) {
        element = lens.getSlotElementType(slotPrefix, slotPrefix.length);
        elementCache.set(slotPrefix, element);
      }

      let slotIsArray: boolean | null = null;
      let slotIsStringy: boolean | null = null;
      let validSymbols = st.validSymbols;
      if (inAppArg) {
        // STRUCTURE — stamp the slot's array-ness, SYNCHRONOUSLY, at the boundary AND mid-atom.
        slotIsArray = arrayCache.get(slotPrefix) ?? null;
        if (!arrayCache.has(slotPrefix)) {
          slotIsArray = lens.getSlotIsArray(slotPrefix, slotPrefix.length);
          arrayCache.set(slotPrefix, slotIsArray);
        }

        // SCALAR-STRING — stamp whether the slot admits a bare word as a string, SYNCHRONOUSLY.
        slotIsStringy = stringyCache.get(slotPrefix) ?? null;
        if (!stringyCache.has(slotPrefix)) {
          slotIsStringy = lens.getSlotAcceptsBareWord(slotPrefix, slotPrefix.length);
          stringyCache.set(slotPrefix, slotIsStringy);
        }
      }

      // VALUE (Σ∩T) — narrow validSymbols ONLY mid-atom (a partial symbol being typed). CUT A: at an ENUM
      // ELEMENT, intersect with the element members (the array analog, reaching inside `(list …)` / `'(…)`);
      // otherwise the in-app-arg Σ∩T narrowing as before.
      const baseValid = st.midToken ? st.validSymbols() : null;
      if (baseValid !== null && baseValid.size > 0) {
        if (element.enum !== null) {
          const members = new Set(element.enum);
          const narrowed = new Set([...baseValid].filter((sym) => members.has(sym)));
          validSymbols = () => narrowed;
        } else if (inAppArg) {
          let narrowed = cache.get(slotPrefix);
          if (narrowed === undefined) {
            narrowed = new Set(lens.getTypeValidCandidates(slotPrefix, slotPrefix.length, [...baseValid]));
            cache.set(slotPrefix, narrowed);
          }
          validSymbols = () => narrowed!;
        }
      }

      // Reconstruct only the fields the mask consumes (see arrival-sampler/oracle-types.ts) + the
      // type-stamped axes (slotIsArray/slotIsStringy for the scalar gates, elementIsStringy/elementEnum for
      // the array-element gate).
      return {
        midToken: st.midToken,
        position: st.position,
        formKind: st.formKind,
        closeable: st.closeable,
        validSymbols,
        slotIsArray,
        slotIsStringy,
        elementIsStringy: element.isStringy,
        elementEnum: element.enum,
      };
    },
  };
}
