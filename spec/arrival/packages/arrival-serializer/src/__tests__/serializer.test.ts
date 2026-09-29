import { describe, expect, it } from "vitest";
import { sexpr, toSExpr, toSExprString } from "../serializer";

describe("S-Expression Serializer", () => {
  describe("new interface with Symbol.toSExpr", () => {
    it("uses Symbol.SExpr for display name", () => {
      class MyClass {
        [Symbol.SExpr]() {
          return "my-special-class";
        }

        [Symbol.toSExpr]() {
          return [":initialized", true];
        }
      }

      const obj = new MyClass();
      expect(toSExprString(obj)).toBe("(my-special-class :initialized #t)");
    });

    it("falls back to displayName, name, or constructor.name", () => {
      class NamedClass {
        static displayName = "DisplayedClass";

        [Symbol.toSExpr]() {
          return [];
        }
      }

      class SimpleClass {
        [Symbol.toSExpr]() {
          return [];
        }
      }

      expect(toSExprString(new NamedClass())).toBe("(DisplayedClass)");
      expect(toSExprString(new SimpleClass())).toBe("(SimpleClass)");
    });

    it("provides context helpers for serialization", () => {
      class ComplexObject {
        constructor(
          public data: string,
          public count: number,
        ) {}

        [Symbol.toSExpr](context: any) {
          return [
            context.keyword("data"),
            context.string(this.data),
            context.keyword("count"),
            this.count,
            context.keyword("computed"),
            context.expr("add", this.count, 10),
          ];
        }
      }

      const obj = new ComplexObject("hello world", 5);
      const result = toSExprString(obj);
      expect(result).toContain("ComplexObject");
      expect(result).toContain(':data "hello world"');
      expect(result).toContain(":count 5");
      expect(result).toContain(":computed");
      expect(result).toContain("(add 5 10)");
    });

    it("handles nested expressions with context.expr", () => {
      class Calculator {
        [Symbol.toSExpr](context: any) {
          return [context.expr("multiply", context.expr("add", 2, 3), context.expr("subtract", 10, 6))];
        }
      }

      const result = toSExprString(new Calculator());
      expect(result).toContain("Calculator");
      expect(result).toContain("multiply");
      expect(result).toContain("(add 2 3)");
      expect(result).toContain("(subtract 10 6)");
    });

    it("symbol helper creates proper keywords", () => {
      class Stateful {
        [Symbol.toSExpr](context: SExprSerializationContext) {
          return [context.symbol("state"), context.symbol("active")];
        }
      }

      expect(toSExprString(new Stateful())).toBe("(Stateful :state :active)");
    });
  });

  describe("array serialization as Scheme lists", () => {
    it("serializes arrays as [ ... ]", () => {
      expect(toSExprString([1, 2, 3])).toBe("[1 2 3]");
      expect(toSExprString(["a", "b", "c"])).toBe("[a b c]"); // AI-readable: symbols not quoted
      expect(toSExprString([])).toBe("[]");
    });

    it("handles nested arrays", () => {
      expect(
        toSExprString([
          [1, 2],
          [3, 4],
        ]),
      ).toBe("[[1 2] [3 4]]");
    });

    it("handles mixed content arrays", () => {
      const mixed = ["text", 42, true, null, { key: "value" }];
      expect(toSExprString(mixed)).toBe("[text 42 #t nil {:key value}]"); // AI-readable format
    });
  });

  describe("object serialization as Scheme records", () => {
    it("serializes plain objects with dict notation", () => {
      expect(toSExprString({ name: "arrival", version: "1.0" })).toBe('{:name arrival :version "1.0"}'); // AI-readable: symbols not quoted unless needed
    });

    it("handles nested objects", () => {
      const obj = {
        name: "test",
        config: {
          enabled: true,
          timeout: 5000,
        },
      };
      expect(toSExprString(obj)).toBe("{:name test :config {:enabled #t :timeout 5000}}"); // AI-readable format
    });

    it("handles empty objects", () => {
      expect(toSExprString({})).toBe("{}");
    });
  });

  describe("primitive type handling", () => {
    it("handles all primitive types correctly", () => {
      expect(toSExprString("hello")).toBe("hello"); // AI-readable: simple strings as symbols
      expect(toSExprString(42)).toBe("42");
      expect(toSExprString(3.14)).toBe("3.14");
      expect(toSExprString(true)).toBe("#t");
      expect(toSExprString(false)).toBe("#f");
      expect(toSExprString(null)).toBe("nil");
      expect(toSExprString(undefined)).toBe("undefined");
      expect(toSExprString(BigInt(9007199254740991))).toBe("9007199254740991");
    });

    it("handles symbols as keywords", () => {
      expect(toSExprString(Symbol.for("my-symbol"))).toBe(":my-symbol");
      expect(toSExprString(Symbol("local"))).toBe(":local");
    });
  });

  describe("basic serialization", () => {
    it("converts primitives", () => {
      expect(toSExpr("hello")).toEqual("hello");
      expect(toSExpr(42)).toEqual(42);
      expect(toSExpr(true)).toEqual(true);
      expect(toSExpr(false)).toEqual(false);
      expect(toSExpr(null)).toEqual("nil");
      expect(toSExpr(undefined)).toEqual("undefined");
    });

    it("converts symbols to keywords", () => {
      expect(toSExpr(Symbol.for("visible"))).toEqual(":visible");
      expect(toSExpr(Symbol.for("not-rendered"))).toEqual(":not-rendered");
    });

    it("converts arrays to lists", () => {
      expect(toSExpr([1, 2, 3])).toEqual(["list", 1, 2, 3]);
      expect(toSExpr(["a", "b", "c"])).toEqual(["list", "a", "b", "c"]);
    });

    it("converts objects to dicts", () => {
      expect(toSExpr({ a: 1, b: 2 })).toEqual(["dict", ":a", 1, ":b", 2]);
      expect(toSExpr({ name: "test", value: 42 })).toEqual(["dict", ":name", "test", ":value", 42]);
    });

    it("handles nested structures", () => {
      const obj = {
        name: "test",
        items: [1, 2, 3],
        meta: { count: 3, active: true },
      };

      expect(toSExpr(obj)).toEqual([
        "dict",
        ":name",
        "test",
        ":items",
        ["list", 1, 2, 3],
        ":meta",
        ["dict", ":count", 3, ":active", true],
      ]);
    });
  });

  describe("custom serialization with intermediate representation", () => {
    it("supports returning SExprSerializable types", () => {
      class DataNode {
        constructor(public data: any) {}

        [Symbol.toSExpr](context: SExprSerializationContext) {
          return [context.keyword("type"), "data-node", context.keyword("value"), this.data];
        }
      }

      const node = new DataNode({ x: 10, y: 20 });
      const result = toSExprString(node);
      expect(result).toContain("DataNode");
      expect(result).toContain(":type data-node"); // AI-readable format
      expect(result).toContain(":value");
      expect(result).toContain("{:x 10 :y 20}");
    });
  });

  describe("formatting with new representations", () => {
    it("formats objects as maps", () => {
      const obj = { name: "test", value: 42 };
      expect(toSExprString(obj)).toBe("{:name test :value 42}"); // AI-readable format
    });

    it("formats custom objects with proper indentation", () => {
      class ComplexComponent {
        [Symbol.toSExpr](context: any) {
          return [
            context.keyword("variants"),
            context.expr("list", "base", "hover", "active"),
            context.keyword("styles"),
            { background: "blue", padding: 10 },
            context.keyword("children"),
            [1, 2, 3],
          ];
        }
      }

      const result = toSExprString(new ComplexComponent());
      expect(result).toContain("(ComplexComponent");
      expect(result).toContain(":variants");
      expect(result).toContain("[base hover active]"); // AI-readable: symbols not quoted
      expect(result).toContain(":styles");
      expect(result).toContain("{:background blue :padding 10}"); // AI-readable format
      expect(result).toContain(":children");
      expect(result).toContain("[1 2 3]");
    });
  });

  describe("helper functions", () => {
    it("sexpr creates tagged expressions", () => {
      const expr = sexpr("add", 1, 2);
      expect(toSExprString(expr)).toBe("(add 1 2)");
    });
  });

  describe("edge cases", () => {
    it("handles circular references gracefully", () => {
      const obj: any = { name: "test" };
      obj.self = obj; // circular reference

      // Should detect circular reference and throw meaningful error
      expect(() => toSExpr(obj)).toThrow();
    });

    it("a value reused across sibling branches is NOT a false cycle (DAG, not a loop)", () => {
      // shared appears twice as siblings — it's on the path only while its own
      // subtree serializes, so the second occurrence must serialize normally.
      // (Regression guard for the shared add-on-enter/delete-on-exit path-set:
      // a naive shared Set without delete-on-exit would throw here.)
      const shared = { tag: "shared" };
      const out = toSExprString({ a: shared, b: shared });
      expect(out).not.toContain("circular");
      // both branches render the shared value's contents
      expect(out.match(/shared/g)?.length).toBe(2);
    });

    it("a value reused at depth across siblings still round-trips both times", () => {
      const leaf = { v: 1 };
      const out = toSExprString([{ left: leaf }, { right: leaf }]);
      expect(out).not.toContain("circular");
      expect(out.match(/:v 1/g)?.length).toBe(2);
    });

    it("handles functions in objects", () => {
      const obj = {
        name: "test",
        fn: () => console.log("hello"),
      };
      // Functions should be skipped or converted to a placeholder
      const result = toSExprString(obj);
      expect(result).toContain(":name test"); // AI-readable format
      // Function should either be skipped or shown as <function>
    });
  });

  describe("tagged literals (#tag)", () => {
    it('renders #tag "value" format', () => {
      class CodeExpr {
        constructor(public code: string) {}

        [Symbol.SExpr]() {
          return "expr";
        }
        [Symbol.toSExpr](ctx: any) {
          return [ctx.tagged("ts", this.code)];
        }
      }

      expect(toSExprString(new CodeExpr("props.url"))).toBe('(expr #ts "props.url")');
    });

    it("escapes quotes in tagged values", () => {
      class CodeExpr {
        constructor(public code: string) {}
        [Symbol.SExpr]() {
          return "expr";
        }
        [Symbol.toSExpr](ctx: any) {
          return [ctx.tagged("ts", this.code)];
        }
      }

      expect(toSExprString(new CodeExpr('items.filter(i => i.name === "active")'))).toBe(
        '(expr #ts "items.filter(i => i.name === \\"active\\")")',
      );
    });

    it("works inline in larger structures", () => {
      class PropView {
        [Symbol.SExpr]() {
          return "args";
        }
        [Symbol.toSExpr](ctx: any) {
          return [
            ctx.keyword("href"),
            ctx.tagged("ts", "props.url"),
            ctx.keyword("title"),
            ctx.string("Hello"),
            ctx.keyword("count"),
            ctx.tagged("ts", "state.items.length"),
          ];
        }
      }

      const result = toSExprString(new PropView());
      expect(result).toContain('#ts "props.url"');
      expect(result).toContain(':title "Hello"');
      expect(result).toContain('#ts "state.items.length"');
    });
  });

  describe("AValue provenance envelope — invisible by default, opt-in via lineageEnvelopes", () => {
    // Same "AValue-duck" fixture shape as r6-serialize-with-extras.test.ts: anything exposing
    // `arrival/toJS` + `kind` + a `provenance` Set is treated as an AValue by the serializer,
    // whether it's a real one or not.
    const stringDuck = (provenance: ReadonlySet<number>) => ({
      "arrival/toJS": () => "hello",
      kind: "string",
      provenance,
    });

    it("empty provenance renders the plain value, not the envelope", () => {
      expect(toSExprString(stringDuck(new Set()))).toBe("hello");
    });

    it("default mode: NON-empty provenance renders IDENTICALLY to empty provenance — the leak fix", () => {
      const empty = toSExprString(stringDuck(new Set()));
      const nonEmpty = toSExprString(stringDuck(new Set([7])));
      expect(nonEmpty).toBe("hello");
      expect(nonEmpty).toBe(empty);
    });

    it("`lineageEnvelopes: true` restores the {kind, provenance, …} envelope for NON-empty provenance", () => {
      const result = toSExprString(stringDuck(new Set([7])), { lineageEnvelopes: true });
      expect(result).toBe("{:kind string :provenance (set 7)}");
    });

    it("`lineageEnvelopes: true` still renders EMPTY provenance plain — nothing to show even opted in", () => {
      const result = toSExprString(stringDuck(new Set()), { lineageEnvelopes: true });
      expect(result).toBe("hello");
    });
  });
});
