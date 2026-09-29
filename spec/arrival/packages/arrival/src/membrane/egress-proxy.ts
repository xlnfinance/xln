/**
 * R9 lazy egress proxies — the container exit of the membrane.
 *
 * Design: RULINGS.md R9 + docs/membrane.md §EGRESS. A native container
 * (AVector / APair / ADict) exits as a lazy, observationally-plain-JS proxy instead
 * of an eager deep copy: elements materialize on first read; a tracker guarantees
 * stable identity per projection — where "projection" is an explicit law:
 *
 *   • BARE (serialization — `arrival/toJS()`, no options): identity = (box), forever.
 *     One module-level WeakMap. Elements materialize through their own `arrival/toJS`
 *     (a nested callable stringifies — that IS the serialization contract).
 *   • MEMBRANE (`arrival/toJS(exit)` — rosetta/exec crossings): identity =
 *     (box, mode, SCOPE). Cache lives on the exporting RegionScope
 *     (`RegionScope.egressProxies`), handed via `MembraneExit.cache`, so a later
 *     invocation re-egressing the same box mints proxies bound to ITS scope instead
 *     of resurrecting wrappers pinned to a closed (or DETACHED) one. Elements
 *     materialize through `exit.element` — full recursive membrane crossing.
 *   • GATED (tier-state egress): identity = (gate, box). A gate is snapshot-scoped
 *     (`tierGateFromSnapshot` mints a fresh closure per snapshot). Never combined
 *     with a membrane exit today (tiering is bare-mode by design); if both are
 *     supplied, the membrane cache wins and the gate still governs materialization.
 *
 * BORROWED carriers (AJSArray/AJSObject) are a FOURTH egress class that never routes
 * here: they egress source identity (`return this.source`) — that IS their membrane
 * contract; a proxy or membrane walk would break it.
 *
 * Mechanics:
 * - Target is a REAL `[]` / `{}` doubling as the materialization cache: every trap
 *   answer is a configurable+writable target property, so Proxy invariants are
 *   trivially satisfiable, `Array.isArray(proxy)` is true for the array shape, and
 *   a second read is a plain property hit.
 * - Proxy registers in its cache slot BEFORE any trap can run, so a cyclic
 *   reach-back resolves to the already-registered proxy (no recursion). JSON.stringify
 *   on such a value fails with the same TypeError a genuinely cyclic plain object
 *   produces — observationally plain JS. Invariant holds PER SLOT.
 * - Write family (set / deleteProperty / defineProperty / setPrototypeOf) throws the
 *   same teaching door family as AJSObject's read-only membrane: egressed value is a
 *   projection of an immutable Scheme value, not a mailbox back into it.
 * - Scalars never route here — they unwrap at their own `arrival/toJS`.
 *
 * Leaf module: imports only AValue base and the interop error — never
 * membrane/env/bridge/rosetta. Membrane recursion reaches this file exclusively as the
 * MembraneExit VALUE built by rosetta's egressAValue (type-only import), so a nested
 * callable gets its reverse-membrane host-fn projection without this module importing
 * callableToHostFn.
 */
import { AValue } from "../values/primitives/AValue.js";
import type { EgressMode, MembraneExit } from "../values/types.js";
import { InteropAccessError } from "../errors.js";

/** BARE-law tracker: same box → same proxy, forever. Deterministic (no options, no
 *  scope) — serialization projection only. */
const bareProxies = new WeakMap<AValue, object>();

/** GATED-law tracker: gate is snapshot-scoped; its proxies are too. */
const gatedProxies = new WeakMap<TierGate, WeakMap<AValue, object>>();

/**
 * R9 RE-ADMISSION: every egress proxy this module mints — under ANY of the three
 * identity laws — registers here at mint time, proxy → original box. Makes the
 * membrane a genuine bifunctor at the container boundary:
 * `jsToScheme(toJS(box)) === box` (rosetta INBOUND_CLAIMS re-admits via this
 * map instead of re-borrowing as fresh AJSArray/AJSObject). One WeakMap, keyed by
 * the PROXY (not the box) — honest inverse of bare/membrane/gated slots above.
 */
const PROXY_ORIGIN = new WeakMap<object, AValue>();

/** Inverse of minting: undefined for anything that isn't one of THIS module's proxies. */
export function originalBoxOf(proxy: object): AValue | undefined {
  return PROXY_ORIGIN.get(proxy);
}

/** Shallow read model a container hands to its proxy: keys() enumerates own string
 *  keys (index strings for array shape); read(key) returns the element (usually a
 *  box, or a raw FFI-passthrough value that never boxed). */
export interface EgressReader {
  keys(): readonly string[];
  read(key: string): unknown;
}

/** Element exit. Membrane routes through exit.element (options + pinned scope +
 *  nested-callable wrapping live in rosetta's closure). Bare dispatches the element's
 *  own serialization protocol; raw FFI-passthrough has no protocol and exits as itself. */
function materializeElement(element: unknown, membrane?: MembraneExit): unknown {
  if (membrane !== undefined) return membrane.element(element);
  return element instanceof AValue ? element["arrival/toJS"]() : element;
}

/**
 * Payload-tiering tier-state gate seam. This module stays a LEAF (preamble) so this
 * interface is ABSTRACT — no PayloadTier/EvidenceTier import. Concrete implementation
 * (provenance/store/tiering.ts tierGateFromSnapshot) closes over its own tier state.
 *
 * Proxy traps are SYNCHRONOUS by spec — a gate can only consult an ALREADY-RESOLVED
 * view of tier state, never await.
 */
export interface TierGate {
  /** true: tier allows the real read through to reader.read(key) — the ONLY path when
   *  a gate is omitted, or every backing payload is still ring-resident (unset ⇒ inert
   *  pass-through). false: key's payload degraded (evicted to stub) — stubbedValue
   *  substitutes; reader.read is never called. */
  allows(key: string): boolean;
  /** Degraded stand-in for a gated-off key. Never re-enters reader.read or
   *  materializeElement — placed directly on the target. */
  stubbedValue(key: string): unknown;
}

/** egressContainerProxy options — membrane pair (materializer + mode + scope-owned
 *  cache) travels as a unit and cannot drift apart at a call site. */
export interface EgressOpts {
  /** Tier-state gate consulted BEFORE reader.read(key) on first materialization.
   *  Omitting is inert pass-through. */
  gate?: TierGate;
  /** Membrane exit — presence switches materialization from bare serialization to
   *  exit.element, and the cache to the exit's scope-owned (box, mode) slots. */
  membrane?: MembraneExit;
}

function writeDoor(kind: "assign" | "mutate", key: string | symbol | undefined): never {
  const verb =
    kind === "assign"
      ? "Cannot assign to an egressed container — writes are banned in the pure-dataflow sandbox"
      : "Cannot restructure an egressed container — mutations are banned in the pure-dataflow sandbox";
  throw new InteropAccessError(
    `${verb}; the value that crossed toJS is a read-only projection of an immutable Scheme value. Build the changed value on the Scheme side and egress that.`,
    typeof key === "symbol" ? key : String(key ?? "<prototype>"),
    "write-banned",
  );
}

/** One cache slot under whichever identity law governs this egress. */
interface ProxySlot {
  get(): object | undefined;
  set(proxy: object): void;
}

function membraneSlot(cache: WeakMap<AValue, Map<EgressMode, object>>, box: AValue, mode: EgressMode): ProxySlot {
  return {
    get: () => cache.get(box)?.get(mode),
    set: (proxy) => {
      let byMode = cache.get(box);
      if (byMode === undefined) {
        byMode = new Map();
        cache.set(box, byMode);
      }
      byMode.set(mode, proxy);
    },
  };
}

function boxSlot(cache: WeakMap<AValue, object>, box: AValue): ProxySlot {
  return {
    get: () => cache.get(box),
    set: (proxy) => cache.set(box, proxy),
  };
}

function gatedSlot(gate: TierGate, box: AValue): ProxySlot {
  let byBox = gatedProxies.get(gate);
  if (byBox === undefined) {
    byBox = new WeakMap();
    gatedProxies.set(gate, byBox);
  }
  return boxSlot(byBox, box);
}

/**
 * Build (or return the already-built) lazy egress proxy for `box`, under the identity
 * law its options select (preamble): membrane ⇒ (box, mode, scope); gated ⇒ (gate, box);
 * bare ⇒ (box) forever.
 *
 * Identity is guaranteed HERE, at the single chokepoint every container's
 * `arrival/toJS(exit?)` calls — membrane.toJS needs no separate pre-check.
 */
export function egressContainerProxy(
  box: AValue,
  shape: "array" | "object",
  reader: EgressReader,
  opts?: EgressOpts,
): object {
  const membrane = opts?.membrane;
  const gate = opts?.gate;
  const slot =
    // eslint-disable-next-line unicorn/no-negated-condition -- present membrane, then present gate; bare slot is the default
    membrane !== undefined
      ? membraneSlot(membrane.cache, box, membrane.modeKey)
      : // eslint-disable-next-line unicorn/no-negated-condition -- present gate before the bare default
        gate !== undefined
        ? gatedSlot(gate, box)
        : boxSlot(bareProxies, box);

  const cached = slot.get();
  if (cached) return cached;

  const names = reader.keys();
  const nameSet = new Set<string>(names);
  const target: Record<PropertyKey, unknown> = shape === "array" ? [] : Object.create(Object.prototype);
  if (Array.isArray(target)) target.length = names.length; // length preset — reads never materialize the spine

  /** Materialize one element onto the target if it's ours and not yet there. */
  const ensure = (key: PropertyKey): void => {
    if (typeof key !== "string" || !nameSet.has(key)) return;
    if (Object.prototype.hasOwnProperty.call(target, key)) return;
    target[key] =
      gate === undefined || gate.allows(key) ? materializeElement(reader.read(key), membrane) : gate.stubbedValue(key);
  };

  const proxy = new Proxy(target, {
    get(t, key, receiver) {
      ensure(key);
      return Reflect.get(t, key, receiver);
    },
    has(t, key) {
      return (typeof key === "string" && nameSet.has(key)) || Reflect.has(t, key);
    },
    ownKeys(t) {
      // Every element key (materialized or not), then whatever else lives on the target
      // ("length" for array shape). Reporting a not-yet-materialized key is legal
      // (target is extensible); gOPD below backs it on demand.
      const extras = Reflect.ownKeys(t).filter((k) => typeof k !== "string" || !nameSet.has(k));
      return [...names, ...extras];
    },
    getOwnPropertyDescriptor(t, key) {
      ensure(key);
      return Reflect.getOwnPropertyDescriptor(t, key);
    },
    set(_t, key) {
      writeDoor("assign", key);
    },
    deleteProperty(_t, key) {
      writeDoor("mutate", key);
    },
    defineProperty(_t, key) {
      writeDoor("mutate", key);
    },
    setPrototypeOf() {
      writeDoor("mutate", undefined);
    },
  });

  // Register BEFORE returning — traps only fire on reads after return, so a cyclic
  // reach-back during later materialization finds this slot already occupied.
  slot.set(proxy);
  // R9 re-admission: every law registers the same proxy → box provenance.
  PROXY_ORIGIN.set(proxy, box);
  return proxy;
}
