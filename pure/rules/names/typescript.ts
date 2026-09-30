// Test titles that a runner executes: describe(...), it(...), test(...) and their .only forms, called the way
// a test file calls them. A call counts only when every bracket around it belongs to an enclosing describe
// (its argument list and its callback body), so a call under `if (false)`, in a helper nobody calls, in a
// skipped describe, in a comment or in a string is not a test.
import { MARK, TYPESCRIPT_LANGUAGE, closeOf, depthsBefore, lex } from "./source.ts";

// Not preceded by `.` or an identifier character (so not re.test(, foo.it(, xit(); only `.only` may follow. The title
// may sit in a wrapper call such as seedTag("...").
const CALL = new RegExp(`(?<![.\\w$])(describe|it|test)(\\.only)?\\s*\\(\\s*(?:\\w+\\s*\\(\\s*)?${MARK}(\\d+)${MARK}`, "g");

type Call = Readonly<{ kind: string; at: number; open: number; title: string }>;

const callsIn = (code: string, strings: readonly string[]): readonly Call[] =>
  [...code.matchAll(CALL)].map((found) => ({
    kind: found[1] ?? "",
    at: found.index,
    open: found.index + found[0].indexOf("("),
    title: strings[Number(found[3])] ?? "",
  }));

export const runnableTitles = (source: string): readonly string[] => {
  const { code, strings } = lex(source, TYPESCRIPT_LANGUAGE);
  const depths = depthsBefore(code);
  const calls = callsIn(code, strings);
  const describes = calls.filter((call) => call.kind === "describe").map((call) => ({ open: call.open, close: closeOf(depths, call.open) }));
  // A describe contributes two brackets around what it holds: the call's ( and the callback's {.
  const reached = (call: Call): boolean =>
    depths[call.at] === 2 * describes.filter((each) => each.open < call.at && call.at < each.close).length;
  return calls.filter(reached).map((call) => call.title);
};
