// Value → string print protocol. Each AValue answers `["arrival/print"](): string`
// and recurses on children through `printValue` — no central type-switch, no drift.
//
// Leaf module: dispatch + the non-AValue residual (raw JS bottoms, foreign objects,
// defensive bare-fn arm). Imports nothing class-specific, so value classes can import
// `printValue` for child recursion without a cycle.

interface Printable {
  "arrival/print"(): string;
}

function isPrintable(v: unknown): v is Printable {
  return v != null && typeof (v as Record<string, unknown>)["arrival/print"] === "function";
}

export function printValue(value: unknown): string {
  if (isPrintable(value)) return value["arrival/print"]();
  return printForeign(value);
}

// Non-AValue residual. Raw bottoms are largely moot post-boxing but kept defensive;
// raw JS functions render as procedures; foreign objects use toString or `#<ctor.name>`.
function printForeign(value: unknown): string {
  if (value === true) return "#t";
  if (value === false) return "#f";
  if (value === null) return "#null";
  if (value === undefined) return "#void";
  if (typeof value === "function") return functionRepr(value);
  if (typeof value === "object") {
    const o = value as { toString?: () => unknown; constructor?: { name?: string } };
    if (typeof o.toString === "function" && o.toString !== Object.prototype.toString) {
      return String(o.toString());
    }
    return o.constructor?.name ? `#<${o.constructor.name}>` : "#<Object>";
  }
  return String(value);
}

// Defensive residual — bare host fns are not scheme values. ACallable answers via isPrintable.
function functionRepr(fn: object): string {
  const f = fn as { __name__?: string | symbol; name?: string };
  if (f.__name__ != null) {
    const name =
      typeof f.__name__ === "symbol" ? f.__name__.toString().replace(/^Symbol\((?:#:)?([^)]+)\)$/, "$1") : f.__name__;
    return `#<procedure:${name}>`;
  }
  if (f.name) {
    return `#<procedure:${f.name.trim()}>`;
  }
  return "#<procedure>";
}
