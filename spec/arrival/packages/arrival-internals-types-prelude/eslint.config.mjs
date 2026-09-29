import { nodejs } from "@here.build/eslint-configs";
import { arrivalOverlay } from "../../eslint.arrival.mjs";

export default [
  ...nodejs,
  ...arrivalOverlay({
    tsconfigRootDir: import.meta.dirname,
    extraIgnores: ["src/**/*.cases.ts"],
  }),
];
