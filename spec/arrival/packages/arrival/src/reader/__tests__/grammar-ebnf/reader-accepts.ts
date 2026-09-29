import { parse } from "../../parse.js";

/** Loose reader: a complete program (zero or more datums) with balanced delimiters. */
export async function readerAccepts(input: string): Promise<boolean> {
  try {
    await parse(input);
    return true;
  } catch {
    return false;
  }
}

export async function readerErrorCode(input: string): Promise<string | undefined> {
  try {
    await parse(input);
    return undefined;
  } catch (e) {
    for (let cur = e; cur instanceof Error; cur = cur.cause as Error | undefined) {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    return "THROWN";
  }
}
