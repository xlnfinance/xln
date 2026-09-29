/**
 * Named paper/ink pairs. RGB is what OSC 11/10 would have reported.
 * The solver (tints.ts) turns these into the canvas; this file is just samples.
 */
import type { Rgb } from "./ansi-cells.js";

export type ThemeInput = {
  readonly name: string;
  readonly bg: Rgb;
  readonly fg: Rgb;
};

export const THEMES: readonly ThemeInput[] = [
  { name: "reference", bg: { r: 32, g: 32, b: 32 }, fg: { r: 204, g: 204, b: 204 } },
  { name: "solarized-dark", bg: { r: 0, g: 43, b: 54 }, fg: { r: 131, g: 148, b: 150 } },
  { name: "solarized-light", bg: { r: 253, g: 246, b: 227 }, fg: { r: 101, g: 123, b: 131 } },
  { name: "gruvbox-dark", bg: { r: 40, g: 40, b: 40 }, fg: { r: 235, g: 219, b: 178 } },
  { name: "catppuccin-mocha", bg: { r: 30, g: 30, b: 46 }, fg: { r: 205, g: 214, b: 244 } },
  { name: "github-light", bg: { r: 255, g: 255, b: 255 }, fg: { r: 31, g: 35, b: 40 } },
  { name: "warm-paper", bg: { r: 46, g: 32, b: 24 }, fg: { r: 232, g: 213, b: 183 } },
];
