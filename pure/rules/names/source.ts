// Turns source text into code with every comment and string taken out, so a name is only ever read from code
// that exists. A string becomes a marker holding its index; a comment becomes one space. Both keep the newlines they
// held, so a line in the result is the line in the source.
export type Lexed = Readonly<{ code: string; strings: readonly string[] }>;

// Comments and strings in one pattern, so a // inside a string is not a comment and a quote inside a comment is
// not a string. The alternatives are tried left to right at each position.
export const SLASH_LANGUAGES = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g;
// A regex literal is read as a token too, so a quote inside one (/"/) does not open a string. A slash starts a
// regex only after an operator or an opening bracket (or `return`), never after an operand, so a division is left alone.
const REGEX_LITERAL = String.raw`(?<=[=(,:\[!&|?{};>]\s*|\breturn\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n\[])+\/[a-z]*`;
export const TYPESCRIPT_LANGUAGE = new RegExp(`${SLASH_LANGUAGES.source}|${REGEX_LITERAL}`, "g");
export const SHELL_LANGUAGE = /(?<![^\s])#[^\n]*|"(?:\\.|[^"\\])*"|'[^']*'/g;
export const SCHEME_LANGUAGE = /;[^\n]*|"(?:\\.|[^"\\])*"/g;

export const MARK = "\u0001";

const isStringToken = (token: string): boolean => /^["'`]/.test(token);

const unquote = (token: string): string => token.slice(1, -1);

export const lex = (source: string, pattern: RegExp): Lexed => {
  const tokens = [...source.matchAll(pattern)];
  const stringTokens = tokens.filter((found) => isStringToken(found[0]));
  const indexAt = new Map(stringTokens.map((found, index) => [found.index, index]));
  const code = source.replace(pattern, (token, offset: number) => {
    const lines = "\n".repeat(token.split("\n").length - 1);
    return isStringToken(token) ? `${MARK}${indexAt.get(offset)}${MARK}${lines}` : ` ${lines}`;
  });
  return { code, strings: stringTokens.map((found) => unquote(found[0])) };
};

const delta = (char: string): number => {
  if ("([{".includes(char)) return 1;
  return ")]}".includes(char) ? -1 : 0;
};

// depths[i] is how many brackets are open before character i. The array is filled by the one reduce that makes
// it and handed out once (registered in style/README as a transient accumulator, like mapAccumResult).
export const depthsBefore = (code: string): Int32Array => {
  const depths = new Int32Array(code.length + 1);
  code.split("").reduce((depth, char, index) => {
    depths[index] = depth;
    return depth + delta(char);
  }, 0);
  depths[code.length] = 0;
  return depths;
};

// The index of the bracket that closes the one at `open`, or the end of the text when it never closes.
export const closeOf = (depths: Int32Array, open: number): number => {
  const opened = depths[open] ?? 0;
  const relative = depths.subarray(open + 1).findIndex((depth) => depth <= opened);
  return relative < 0 ? depths.length - 1 : open + relative;
};
