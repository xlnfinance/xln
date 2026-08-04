/** ANSI theme for the xln CLI wallet. */

export const theme = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  inverse: '\x1b[7m',
  credit: '\x1b[33m', // yellow — credit capacity
  collateral: '\x1b[32m', // green
  debt: '\x1b[31m', // red
  accent: '\x1b[36m', // cyan
  muted: '\x1b[90m',
  warn: '\x1b[33m',
  ok: '\x1b[32m',
  err: '\x1b[31m',
  title: '\x1b[97m',
} as const;

export const paint = (color: keyof typeof theme, text: string): string =>
  `${theme[color]}${text}${theme.reset}`;

export const colorizeBar = (ascii: string): string => {
  let out = '';
  let mode: 'credit' | 'collateral' | 'plain' = 'credit';
  for (const ch of ascii) {
    if (ch === '[') {
      out += `${theme.muted}[${theme.reset}`;
      mode = 'credit';
      continue;
    }
    if (ch === ']') {
      out += `${theme.muted}]${theme.reset}`;
      continue;
    }
    if (ch === '|') {
      out += `${theme.bold}|${theme.reset}`;
      mode = 'credit';
      continue;
    }
    if (ch === '=') {
      mode = 'collateral';
      out += `${theme.collateral}=${theme.reset}`;
      continue;
    }
    if (ch === '-') {
      const color = mode === 'collateral' ? theme.collateral : theme.credit;
      // debt/credit both use '-', tint credit yellow; after collateral band use debt red on right side
      out += `${color}-${theme.reset}`;
      continue;
    }
    out += ch;
  }
  return out;
};

export const colorizeTwinSegment = (ch: string, kind: 'credit' | 'collateral' | 'debt'): string => {
  if (ch === ' ') return ' ';
  if (kind === 'collateral') return `${theme.collateral}${ch}${theme.reset}`;
  if (kind === 'debt') return `${theme.debt}${ch}${theme.reset}`;
  return `${theme.credit}${ch}${theme.reset}`;
};
