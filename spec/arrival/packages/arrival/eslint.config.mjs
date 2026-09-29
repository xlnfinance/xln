import { nodejs } from "@here.build/eslint-configs";
import { arrivalOverlay } from "../../eslint.arrival.mjs";

// The arrow-fn trap: a symbol.native/symbol.rosetta impl must be `function (this: CallCtx, …)`, never an arrow.
const arrowFnTrap = {
  selector:
    "CallExpression[callee.type='TaggedTemplateExpression'][callee.tag.type='MemberExpression'][callee.tag.object.name='symbol'][callee.tag.property.name=/^(native|rosetta)$/] > ArrowFunctionExpression:nth-child(2)",
  message:
    "arrow-fn trap: a symbol.native/symbol.rosetta impl must be `function (this: CallCtx, …)`, not an arrow — dispatch delivers the live RunContext via `this`, and an arrow structurally cannot read it (silently minting CONSTANT_CTX-shaped values instead). See docs/working-proposals/arrival-constant-ctx-audit-2026-07-11.md §4.",
};

// Re-export ban: `export … from` belongs ONLY in an index.ts barrel.
const reexportBan = {
  selector: "ExportAllDeclaration, ExportNamedDeclaration[source]",
  message:
    "Re-export (`export … from`) only in an index.ts barrel. Elsewhere import from the symbol's real home — a passthrough hides the real export.",
};

export default [
  ...nodejs,
  ...arrivalOverlay({
    tsconfigRootDir: import.meta.dirname,
    extraRules: {
      "@typescript-eslint/no-unsafe-function-type": "off",
      "unicorn/no-this-assignment": "off",
      "@typescript-eslint/no-this-alias": "off",
      "sonarjs/public-static-readonly": "off",
      "unicorn/filename-case": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-restricted-syntax": ["error", arrowFnTrap, reexportBan],
    },
    extraConfigs: [
      {
        files: ["**/index.ts"],
        rules: { "no-restricted-syntax": ["error", arrowFnTrap] },
      },
    ],
    extraIgnores: ["debug-*.ts", "lib/**"],
  }),
];
