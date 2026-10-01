// Arrival property names: (property "..." ...), (step-property "..." ...), (liveness "..." ...), read from code
// with comments and strings taken out, so a property in a comment or inside a string is not one.
import { MARK, SCHEME_LANGUAGE, lex } from "./source.ts";

const PROPERTY = new RegExp(`\\((?:step-property|property|liveness)\\s+${MARK}(\\d+)${MARK}`, "g");

export const propertyNames = (source: string): readonly string[] => {
  const { code, strings } = lex(source, SCHEME_LANGUAGE);
  return [...code.matchAll(PROPERTY)].map((found) => strings[Number(found[1])] ?? "");
};
