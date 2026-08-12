export type ParsedArgs = {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

export const parseArgs = (argv: string[]): ParsedArgs => {
  const args = argv.slice(2);
  if (args.length === 0) return { command: null, positionals: [], flags: {} };
  const command = args[0]!.startsWith('-') ? null : args[0]!;
  const rest = command ? args.slice(1) : args;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === '--') {
      positionals.push(...rest.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (!next || next.startsWith('-')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
      continue;
    }
    if (token.startsWith('-') && token.length === 2) {
      const key = token.slice(1);
      const next = rest[i + 1];
      if (!next || next.startsWith('-')) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
      continue;
    }
    positionals.push(token);
  }
  return { command, positionals, flags };
};

export const flagString = (flags: Record<string, string | boolean>, name: string, defaultValue?: string): string | undefined => {
  const value = flags[name];
  if (typeof value === 'string') return value;
  return defaultValue;
};

export const flagBool = (flags: Record<string, string | boolean>, name: string): boolean =>
  flags[name] === true || flags[name] === 'true' || flags[name] === '1';

export const flagNumber = (flags: Record<string, string | boolean>, name: string, defaultValue: number): number => {
  const value = flags[name];
  if (typeof value !== 'string') return defaultValue;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid --${name}: ${value}`);
  return n;
};
