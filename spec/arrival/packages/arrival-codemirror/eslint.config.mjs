import { nodejs } from "@here.build/eslint-configs";
import { arrivalOverlay } from "../../eslint.arrival.mjs";

export default [
  ...nodejs,
  ...arrivalOverlay({
    tsconfigRootDir: import.meta.dirname,
    extraConfigs: [
      {
        // Radix-number matchers are lifted from @codemirror/legacy-modes/mode/scheme.
        // `stream.match(re)` is the consuming StreamParser API — prefer-regexp-test
        // rewrites it into a non-consuming `re.test(stream)`.
        files: ["src/scheme-sugarcoat.ts"],
        rules: {
          "sonarjs/regex-complexity": "off",
          "sonarjs/slow-regex": "off",
          "regexp/no-useless-non-capturing-group": "off",
          "regexp/no-super-linear-backtracking": "off",
          "unicorn/prefer-regexp-test": "off",
        },
      },
    ],
  }),
];
